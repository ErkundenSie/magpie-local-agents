import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { effortValues, parseChatRequest, renderConversation, serveChat } from './chat-wire.mjs';
import { listAgents, launchAgent } from './launch.mjs';
import { AgentSession } from './session.mjs';
import { displayError } from './rpc.mjs';
import { createAgyUsageReader } from './agy-quota.mjs';
import { createCodexUsageReader } from './codex-quota.mjs';
import { createClaudeQuota } from './claude-quota.mjs';
import { createGrokUsageReader } from './grok-quota.mjs';
import { agyResumeStore, callerScope, hash, launchIdentity } from './agy-resume.mjs';
import { enabledQuotaAgents } from './quota-selection.mjs';

export const providerId = 'local-cli';
const name = 'Local CLI';
const baseURL = 'https://local-cli.invalid/v1';
const npm = '@ai-sdk/openai-compatible';
const linkMarker = 'local-cli-linked';
const maxConcurrent = 3;
const maxIdle = 4;
const maxBodyBytes = 2 * 1024 * 1024;
const turnMs = 5 * 60 * 1000;
const idleMs = 10 * 60 * 1000;
const maxParked = 8;
const settleMs = 60;

// A CLI's own quota or rate-limit message is a 429, not a broken upstream: it
// tells the caller to wait instead of retrying at once.
const rateLimited = /usage limit|rate[ _-]?limit|quota|too many requests|\b429\b/i;

function errorStatus(error) {
  if (error?.status) return error.status;
  return rateLimited.test(String(error?.message ?? '')) ? 429 : 502;
}

function jsonError(status, message) {
  const type = status < 500 && status !== 429 ? 'invalid_request_error' : 'upstream_error';
  return Response.json({ error: { type, message: displayError(message) } }, { status });
}

function statusError(status, message) {
  return Object.assign(new Error(message), { status });
}

const shortAgent = { codex: 'Codex', claude: 'Claude', antigravity: 'Antigravity', grok: 'Grok' };

function modelInfo(id, label) {
  return {
    id, name: label, providerID: providerId, api: { id, url: baseURL, npm },
    capabilities: { temperature: false, toolcall: true, attachment: false, reasoning: true,
      input: { text: true, image: true }, output: { text: true } },
  };
}

function publicModelId(agent, native) {
  if (!native) return `${agent}-default`;
  if (native === 'default' || !/^[a-zA-Z0-9._-]{1,96}$/.test(native)) return null;
  return `${agent}-${native}`;
}

function effortVariants(efforts) {
  return Object.fromEntries([...effortValues].filter((effort) => efforts.includes(effort))
    .map((effort) => [effort, { reasoningEffort: effort }]));
}

function agyModelFamilies(models) {
  const nativeIds = new Set(models.map(({ id }) => id));
  const families = new Map();
  for (const model of models) {
    if (!publicModelId('antigravity', model.id)) continue;
    const separator = model.id.lastIndexOf('-');
    if (separator < 1) continue;
    const id = model.id.slice(0, separator);
    const effort = model.id.slice(separator + 1);
    if (!effortValues.has(effort) || nativeIds.has(id) || !publicModelId('antigravity', id)) continue;
    if (!families.has(id)) families.set(id, new Map());
    families.get(id).set(effort, model);
  }
  for (const [id, variants] of families) {
    if (variants.size < 2) families.delete(id);
  }
  return families;
}

const plainText = (content) => Array.isArray(content) && content.every((part) => part.type === 'text')
  ? content.map((part) => part.text).join('')
  : content;
// `at` is the message the image belongs to. Comparing the image's own ordinal
// with the message count drops a picture that arrives later in the same chat.
const imagesFrom = (images, historyLength) => images.filter((image) => image.at >= historyLength);
const toolAnswer = (result, images) => images.length
  ? { parts: result.content, images: images.map(({ data, mimeType }) => ({ data, mimeType })) }
  : plainText(result.content) ?? '';

function fingerprint(messages, count = messages.length) {
  return hash(JSON.stringify(messages.slice(0, count).map((message) => {
    const { content, tool_calls, refusal, ...fields } = message;
    return {
      ...fields, content: plainText(content) ?? '',
      ...(tool_calls?.length && { tool_calls }),
      ...(refusal != null && { refusal }),
    };
  })));
}

function historyFingerprint(request, count, reply) {
  const messages = reply ? [...request.messages, reply] : request.messages;
  const history = fingerprint(messages, count);
  if (request.caller === undefined) return history;
  const images = request.images.filter(({ at }) => at < count)
    .map(({ at, mimeType, data }) => [at, mimeType, hash(data)]);
  return hash(JSON.stringify([history, images]));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A Relay is the queue between what a CLI session produces and one HTTP
// response. It outlives a response: a parked conversation keeps pushing into
// it, and the caller's next request drains the same queue.
class Relay {
  #queue = [];
  #waiter;

  push(event) {
    if (this.#waiter) {
      const wake = this.#waiter;
      this.#waiter = undefined;
      wake(event);
    } else {
      this.#queue.push(event);
    }
  }

  unshift(event) {
    this.#queue.unshift(event);
  }

  take() {
    return this.#queue.shift();
  }

  next() {
    const event = this.#queue.shift();
    if (event) return Promise.resolve(event);
    return new Promise((resolve) => { this.#waiter = resolve; });
  }
}

function readProviderSelection() {
  try { return readFileSync(join(process.cwd(), 'providers.json'), 'utf8'); }
  catch { return null; }
}

export function providerHooks(root, { bridge, agyResume, readSelection = readProviderSelection, quotaReaders } = {}) {
  const resumeStore = agyResumeStore(root, agyResume);
  const readAgyUsage = quotaReaders?.antigravity ?? createAgyUsageReader(root);
  const readCodexUsage = quotaReaders?.codex ?? createCodexUsageReader(root);
  const readGrokUsage = quotaReaders?.grok ?? createGrokUsageReader(root);
  const claudeQuota = createClaudeQuota();
  const readClaudeUsage = quotaReaders?.claude ?? (() => claudeQuota.read());
  const resumable = new Set(['antigravity', 'grok']);
  const retiring = new Set();
  let running = 0;
  let stopped = false;
  const catalog = new Map();
  const turns = new Map();
  const pool = new Map();
  const parked = new Map();

  async function withSession(agent, options, signal, emit, use) {
    signal?.throwIfAborted();
    const temporary = await mkdtemp(join(tmpdir(), 'magpie-local-cli-'));
    let session;
    const abort = () => session?.close();
    try {
      signal?.throwIfAborted();
      const launch = launchAgent(root, agent, temporary, { gateway: true });
      session = new AgentSession(agent, launch, emit, { gateway: true, ...options });
      signal?.addEventListener('abort', abort, { once: true });
      await session.start();
      signal?.throwIfAborted();
      return await use(session);
    } finally {
      signal?.removeEventListener('abort', abort);
      session?.close();
      await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
    }
  }

  function discover(agent) {
    const previous = catalog.get(agent.id);
    if (previous?.until > Date.now()) return previous.result;
    const result = withSession(agent.id, {}, AbortSignal.timeout(8500), () => {},
      (session) => agent.id === 'antigravity' ? session.listAgyModels() : session.listModels());
    const row = { until: Date.now() + 5 * 60 * 1000, result };
    catalog.set(agent.id, row);
    row.result = result.catch(() => {
      row.until = Date.now() + 20000;
      return [];
    });
    return row.result;
  }

  function localModels() {
    return listAgents(root).filter(({ available }) => available);
  }

  async function models(_provider, { auth } = {}) {
    const agents = localModels();
    const native = auth ? await Promise.all(agents.map(discover)) : [];
    const result = {};
    for (const [index, agent] of agents.entries()) {
      const fallback = publicModelId(agent.id);
      result[fallback] = modelInfo(fallback, shortAgent[agent.id] || agent.id);
      for (const model of native[index] ?? []) {
        if (typeof model?.id !== 'string' || model.id.startsWith('magpie/')) continue;
        const id = publicModelId(agent.id, model.id);
        if (id) {
          const variants = effortVariants(model.efforts ?? []);
          result[id] = {
            ...modelInfo(id, model.name || model.id),
            ...(Object.keys(variants).length && { variants }),
          };
        }
      }
      if (agent.id === 'antigravity') {
        for (const [family, variants] of agyModelFamilies(native[index] ?? [])) {
          const id = publicModelId(agent.id, family);
          result[id] = {
            ...modelInfo(id, family),
            variants: effortVariants([...variants.keys()]),
          };
        }
      }
    }
    return result;
  }

  function release(record) {
    if (!record || record.closed) return;
    record.closed = true;
    turns.delete(record.id);
    pool.delete(record.id);
    parked.delete(record.id);
    clearTimeout(record.idleTimer);
    if (record.counted) {
      record.counted = false;
      running--;
    }
    if (record.attached) bridge?.close(record.attached.token);
    const cleanup = () => rm(record.dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 100 }).catch(() => {});
    if (!record.checkpoint) {
      record.session?.close();
      void cleanup();
      return;
    }
    // Other gateway instances can claim a completed checkpoint once this
    // process has relinquished the live native session, or after it exits.
    const done = record.session.retireAgySession()
      .then(() => resumeStore.release(record.checkpoint), () => {})
      .finally(cleanup)
      .finally(() => retiring.delete(done));
    retiring.add(done);
  }

  // keepIdle parks a finished conversation's session for the next turn of the
  // same conversation, so it neither cold-starts nor re-reads its history.
  function keepIdle(record) {
    if (record.closed) return;
    record.callIds = undefined;
    if (record.counted) {
      record.counted = false;
      running--;
    }
    clearTimeout(record.idleTimer);
    record.relay = new Relay();
    pool.set(record.id, record);
    record.idleTimer = setTimeout(() => {
      if (pool.get(record.id) === record) pool.delete(record.id);
      release(record);
    }, idleMs);
    record.idleTimer.unref?.();
    for (const [key, other] of pool) {
      if (pool.size <= maxIdle) break;
      if (other === record) continue;
      pool.delete(key);
      release(other);
    }
  }

  // openTurn launches a CLI with the caller's tools attached as MCP tools, so
  // the model calls them natively instead of through a text envelope.
  async function openTurn(agentId, model, request, toolConfig, checkpoint) {
    if (running >= maxConcurrent) throw statusError(429, 'All Local CLI request slots are in use.');
    const { tools, caller } = request;
    const selectedModel = model ?? checkpoint?.model;
    const effort = request.effort ?? (model === undefined || model === checkpoint?.model ? checkpoint?.effort : undefined);
    running++;
    let dir;
    try { dir = await mkdtemp(join(tmpdir(), 'magpie-local-cli-')); }
    catch (error) { running--; throw error; }
    const record = {
      id: randomUUID(), agent: agentId, model: selectedModel, dir, toolConfig, caller,
      relay: new Relay(), counted: true, effort,
    };
    turns.set(record.id, record);
    try {
      if (stopped) throw statusError(503, 'The Local CLI provider has stopped.');
      const attached = tools.length ? bridge?.attach(tools) : undefined;
      record.attached = attached;
      if (attached) attached.record = record;
      const launch = launchAgent(root, agentId, dir, {
        gateway: true,
        clientTools: Boolean(tools.length),
        mcpServers: attached ? [attached.spec] : [],
      });
      if (resumable.has(agentId)) record.launchHash = launchIdentity(launch, agentId);
      if (checkpoint && checkpoint.launchHash !== record.launchHash) throw new Error('The Antigravity launch settings have changed.');
      const session = new AgentSession(agentId, launch, (event) => {
        if (event.type === 'usage') record.usage = event.usage;
        else if (event.type === 'claude_limit') claudeQuota.observe(event.limit);
        else if (event.type === 'text' || event.type === 'thought') record.relay.push(event);
        else if (event.type === 'error') record.relay.push({ type: 'error', error: new Error(event.message) });
      }, {
        gateway: true, model: selectedModel, tools,
        mcpServers: attached ? [attached.spec] : [],
        clientTools: Boolean(tools.length),
      });
      record.session = session;
      // A CLI tool call becomes a queue event and the caller answers it by ID.
      record.onToolCall = (call) => {
        if (agentId === 'antigravity' && !record.prompting) {
          bridge.answer(call.id, 'No gateway turn is accepting tool calls.', true);
          return;
        }
        record.relay.push({ type: 'call', call });
      };
      session.onToolCall = record.onToolCall;
      await session.start({ resumeId: checkpoint?.sessionId });
      if (effort !== undefined) await session.setEffort(effort);
      if (stopped) throw statusError(503, 'The Local CLI provider has stopped.');
      return record;
    } catch (error) {
      release(record);
      throw error;
    }
  }

  // collect gathers one tool call plus any siblings the CLI raised alongside it.
  async function collect(record, first) {
    const calls = [first];
    for (let index = 0; index < 8; index++) {
      await sleep(settleMs);
      const event = record.relay.take();
      if (!event) continue;
      if (event.type === 'call') calls.push(event.call);
      else { record.relay.unshift(event); break; }
    }
    return calls;
  }

  async function pump(record, emit, { parallel, signal }) {
    const aborted = new Promise((_, reject) => {
      if (!signal) return;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const event = await Promise.race([record.relay.next(), aborted]);
      if (event.type === 'text' || event.type === 'thought') { emit(event.text, event.type); continue; }
      if (event.type === 'end') return { reason: event.reason, usage: record.usage };
      if (event.type === 'error') throw event.error;
      if (event.type === 'call') {
        const calls = await collect(record, event.call);
        if (parallel === false) {
          for (const extra of calls.slice(1)) bridge.answer(extra.id, 'Parallel tool calls are disabled for this request.', true);
          calls.length = 1;
        }
        return { reason: 'tool_calls', toolCalls: calls };
      }
    }
  }

  function matchesHistory(record, toolConfig, request, fingerprints) {
    if (record.toolConfig !== toolConfig || record.caller !== request.caller ||
        record.historyLength >= request.messages.length) return false;
    const length = record.historyLength;
    if (!fingerprints.has(length)) fingerprints.set(length, historyFingerprint(request, length));
    return fingerprints.get(length) === record.historyHash;
  }

  function continuation(length, request) {
    const tail = request.messages.slice(length);
    if (tail.some((message) => message.role === 'assistant' || message.role === 'tool') ||
        !tail.some((message) => message.role === 'user')) return undefined;
    const images = imagesFrom(request.images, length);
    return { images, prompt: renderConversation({ messages: tail }, {
      nativeTools: request.nativeTools, continuation: true, imageCount: images.length,
    }) };
  }

  function claimTurn(agent, model, toolConfig, request, fingerprints) {
    const { messages } = request;
    for (const record of parked.values()) {
      // A turn that is already running cannot change model, so this one must match.
      if (record.model !== model || (request.effort !== undefined && record.effort !== request.effort)) continue;
      if (record.session.closed) { release(record); continue; }
      if (record.agent !== agent || !matchesHistory(record, toolConfig, request, fingerprints)) continue;
      const results = messages.slice(record.historyLength);
      const ids = new Set(results.map((result) => result.tool_call_id));
      if (results.length !== record.callIds.length || ids.size !== results.length ||
          results.some((result) => result.role !== 'tool') || !record.callIds.every((id) => ids.has(id) && bridge?.has(id))) continue;
      parked.delete(record.id);
      clearTimeout(record.idleTimer);
      return { record, results };
    }
    for (const record of pool.values()) {
      if (record.session.closed) { release(record); continue; }
      if (record.agent !== agent || !matchesHistory(record, toolConfig, request, fingerprints)) continue;
      const followUp = continuation(record.historyLength, request);
      if (!followUp) continue;
      if (record.checkpoint && !resumeStore.take(record.checkpoint)) { release(record); continue; }
      record.checkpoint = undefined;
      pool.delete(record.id);
      clearTimeout(record.idleTimer);
      return { record, ...followUp };
    }
    return {};
  }

  function park(record, calls) {
    record.callIds = calls.map((call) => call.id);
    record.counted = false;
    running--;
    parked.set(record.id, record);
    record.idleTimer = setTimeout(() => release(record), idleMs);
    record.idleTimer.unref?.();
    if (parked.size > maxParked) release(parked.values().next().value);
  }

  async function fetchLocal(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const signal = init?.signal;
    if (url.href === `${baseURL}/models` && init?.method === 'GET') {
      const available = await models(null, { auth: true });
      return Response.json({ object: 'list', data: Object.keys(available).map((id) => ({ id, object: 'model', owned_by: providerId })) });
    }
    if (url.href !== `${baseURL}/chat/completions` || init?.method !== 'POST') return jsonError(404, 'Local CLI supports Chat Completions.');
    if (typeof init.body !== 'string' || Buffer.byteLength(init.body) > maxBodyBytes) return jsonError(400, 'A JSON chat request of at most 2 MiB is required.');

    let body;
    let request;
    try {
      body = JSON.parse(init.body);
      request = parseChatRequest(body, { nativeTools: Boolean(bridge) });
    } catch (error) { return jsonError(400, error.message); }
    const agent = localModels().find(({ id }) => request.model.startsWith(`${id}-`));
    if (!agent) return jsonError(404, 'This local CLI is unavailable. Install it and sign in from the terminal.');
    const native = request.model.slice(agent.id.length + 1);
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(native)) return jsonError(400, 'Invalid native model ID.');
    if (request.toolMode && !bridge) return jsonError(503, 'This host cannot serve tools for local CLI models.');
    if (resumable.has(agent.id)) request.caller = callerScope(input, init, body);
    let model = native === 'default' ? undefined : native;
    if (agent.id === 'antigravity' && model) {
      const variants = agyModelFamilies(await discover(agent)).get(model);
      if (variants) {
        const effort = request.effort ?? (variants.has('high') ? 'high' : [...effortValues].reverse().find((value) => variants.has(value)));
        const selected = variants.get(effort);
        if (!selected) return jsonError(400, `Antigravity model ${model} offers these reasoning levels: ${[...variants.keys()].join(', ')}.`);
        model = selected.id;
        request.effort = undefined; // The native model ID already selects the effort.
      }
    } else if (agent.id !== 'antigravity' && request.effort === 'max') {
      return jsonError(400, 'The max reasoning level is only supported by Antigravity.');
    }

    const { messages, tools, toolChoice, parallelToolCalls } = request;
    const toolConfig = hash(JSON.stringify([tools, toolChoice, parallelToolCalls]));
    let active;
    let outcome;
    try {
      return await serveChat(request, async ({ signal: clientSignal, emit }) => {
        const deadline = AbortSignal.any([clientSignal, AbortSignal.timeout(turnMs)]);
        if (stopped) throw statusError(503, 'The Local CLI provider has stopped.');
        if (running >= maxConcurrent) throw statusError(429, 'All Local CLI request slots are in use.');
        // `prompt` is undefined when the CLI continues a turn it never left.
        const begin = (record, prompt, images = request.images) => {
          active = record;
          if (prompt === undefined) return;
          deadline.throwIfAborted();
          record.usage = undefined;
          record.prompting = true;
          void record.session.prompt(prompt, images).then(
            (reason) => record.relay.push({ type: 'end', reason }),
            (error) => record.relay.push({ type: 'error', error }),
          ).finally(() => { record.prompting = false; });
        };
        const fresh = async () => begin(await openTurn(agent.id, model, request, toolConfig), request.prompt);
        const fingerprints = new Map();
        const claimed = claimTurn(agent.id, model, toolConfig, request, fingerprints);
        const nextModel = model !== undefined && claimed.record && claimed.record.model !== model ? model : undefined;
        const nextEffort = request.effort !== undefined && claimed.record &&
          (nextModel !== undefined || claimed.record.effort !== request.effort) ? request.effort : undefined;
        if (!claimed.record) {
          const checkpoint = resumable.has(agent.id) && resumeStore?.claim((entry) =>
            (entry.agent ?? 'antigravity') === agent.id &&
            matchesHistory(entry, toolConfig, request, fingerprints) && continuation(entry.historyLength, request));
          if (checkpoint) {
            const next = continuation(checkpoint.historyLength, request);
            try { active = await openTurn(agent.id, model, request, toolConfig, checkpoint); }
            catch { /* Unsupported or unavailable native sessions are replayed. */ }
            if (active) begin(active, next.prompt, next.images);
            else await fresh();
          } else {
            await fresh();
          }
        } else {
          active = claimed.record;
          active.counted = true;
          running++;
          // A result the bridge no longer holds means that turn expired while
          // the caller was away, so the transcript is replayed instead.
          const delivered = claimed.results?.every((result, offset) => bridge.answer(
            result.tool_call_id,
            toolAnswer(result, request.images.filter((image) => image.at === active.historyLength + offset)),
          ));
          if (delivered === false) {
            release(active);
            await fresh();
          } else if (!claimed.results && (nextModel !== undefined || nextEffort !== undefined)) {
            // The caller changed model or reasoning level mid-conversation:
            // switch this session instead of dropping its context.
            try {
              if (nextModel !== undefined) await active.session.setModel(nextModel);
              if (nextEffort !== undefined) await active.session.setEffort(nextEffort);
              if (nextModel !== undefined) active.model = nextModel;
              if (nextEffort !== undefined) active.effort = nextEffort;
              begin(active, claimed.prompt, claimed.images);
            } catch {
              release(active);
              await fresh();
            }
          } else {
            begin(active, claimed.results ? undefined : claimed.prompt, claimed.results ? undefined : claimed.images);
          }
        }
        try {
          deadline.throwIfAborted();
          outcome = await pump(active, emit, { parallel: parallelToolCalls, signal: deadline });
          return outcome;
        } catch (error) {
          release(active);
          throw error;
        }
      }, signal, {
        nativeTools: request.toolMode,
        onReply(message) {
          if (active.closed) return;
          active.historyLength = messages.length + 1;
          active.historyHash = historyFingerprint(request, active.historyLength, message);
          if (message.tool_calls?.length) {
            park(active, message.tool_calls);
          } else if (['completed', 'end_turn', 'stop', 'max_tokens', 'max_turn_requests'].includes(outcome.reason)) {
            if (active.session.canCheckpoint) {
              active.checkpoint = resumeStore?.save(active);
            }
            keepIdle(active);
          } else {
            release(active);
          }
        },
        onStreamError: () => release(active),
      });
    } catch (error) {
      release(active);
      if (signal?.aborted) throw signal.reason;
      return jsonError(errorStatus(error), error.message);
    }
  }

  return {
    stop() {
      stopped = true;
      for (const record of turns.values()) release(record);
      return Promise.all(retiring);
    },
    config(config) {
      config.provider ??= {};
      config.provider[providerId] = { name, api: baseURL, npm, models: {} };
    },
    provider: { id: providerId, models },
    auth: {
      provider: providerId,
      single: true,
      methods: [{
        type: 'api', keyless: true, label: 'Connect local CLIs (sign-in managed by each CLI)',
        labels: { zh: '关联本机 CLI（登录由各 CLI 管理）', 'zh-TW': '連結本機 CLI（登入由各 CLI 管理）' },
        async authorize() {
          if (!localModels().length) return { type: 'failed', error: 'No supported local CLI executable was found.' };
          return { type: 'success', key: linkMarker };
        },
      }],
      async usage(getAuth) {
        if ((await getAuth())?.key !== linkMarker) return { windows: [] };
        let enabled = null;
        try { enabled = enabledQuotaAgents(readSelection()); }
        catch { enabled = null; }
        const want = (agent) => enabled === null || enabled.has(agent);
        const readers = [
          ['antigravity', readAgyUsage],
          ['codex', readCodexUsage],
          ['grok', readGrokUsage],
          ['claude', readClaudeUsage],
        ];
        const reports = await Promise.all(readers.filter(([agent]) => want(agent)).map(([, read]) => read()));
        const windows = reports.flatMap((report) => report.windows ?? []);
        const error = reports.map((report) => report.error).filter(Boolean).join(' ');
        const readAt = reports.map((report) => report.readAt).filter(Boolean).sort()[0];
        return { windows, ...(readAt && windows.length && { readAt }), ...(error && { error }) };
      },
      async loader(getAuth) {
        if ((await getAuth())?.key !== linkMarker) return {};
        return { baseURL, fetch: fetchLocal };
      },
    },
  };
}
