import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChatRequest, renderConversation, serveChat } from './chat-wire.mjs';
import { listAgents, launchAgent } from './launch.mjs';
import { AgentSession } from './session.mjs';
import { displayError } from './rpc.mjs';

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

const hash = (value) => createHash('sha256').update(value).digest('hex');
const plainText = (content) => Array.isArray(content) && content.every((part) => part.type === 'text')
  ? content.map((part) => part.text).join('')
  : content;

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

export function providerHooks(root, { bridge } = {}) {
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
    const result = withSession(agent.id, {}, AbortSignal.timeout(8500), () => {}, (session) => session.listModels());
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
      result[fallback] = modelInfo(fallback, `${agent.label} · CLI 默认模型`);
      for (const model of native[index] ?? []) {
        if (typeof model?.id !== 'string' || model.id.startsWith('magpie/')) continue;
        const id = publicModelId(agent.id, model.id);
        if (id) result[id] = modelInfo(id, `${model.name || model.id} · ${agent.label}`);
      }
    }
    return result;
  }

  function release(record, close = true) {
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
    if (close) record.session?.close();
    void rm(record.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => {});
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
  async function openTurn(agentId, model, request, toolConfig) {
    const { tools } = request;
    running++;
    let dir;
    try { dir = await mkdtemp(join(tmpdir(), 'magpie-local-cli-')); }
    catch (error) { running--; throw error; }
    const record = {
      id: randomUUID(), agent: agentId, model, dir, toolConfig, relay: new Relay(), counted: true,
      effort: request.effort,
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
      const session = new AgentSession(agentId, launch, (event) => {
        if (event.type === 'usage') record.usage = event.usage;
        else if (event.type === 'text') record.relay.push({ type: 'text', text: event.text });
        else if (event.type === 'error') record.relay.push({ type: 'error', error: new Error(event.message) });
      }, {
        gateway: true, model, tools,
        mcpServers: attached ? [attached.spec] : [],
        clientTools: Boolean(tools.length),
      });
      record.session = session;
      // The bridge answers through the record: a CLI tool call becomes a queue
      // event here, and the caller's next request answers it by id.
      record.onToolCall = (call) => record.relay.push({ type: 'call', call });
      session.onToolCall = record.onToolCall;
      await session.start();
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
      if (event.type === 'text') { emit(event.text); continue; }
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

  function compatible(record, agent, toolConfig, messages) {
    if (record.session.closed) { release(record); return false; }
    return record.agent === agent && record.toolConfig === toolConfig &&
      record.historyLength < messages.length && fingerprint(messages, record.historyLength) === record.historyHash;
  }

  function claimTurn(agent, model, toolConfig, request) {
    const { messages } = request;
    for (const record of parked.values()) {
      // A turn that is already running cannot change model, so this one must match.
      if (record.model !== model) continue;
      if (!compatible(record, agent, toolConfig, messages)) continue;
      const results = messages.slice(record.historyLength);
      const ids = new Set(results.map((result) => result.tool_call_id));
      if (results.length !== record.callIds.length || ids.size !== results.length ||
          results.some((result) => result.role !== 'tool') || !record.callIds.every((id) => ids.has(id) && bridge?.has(id))) continue;
      parked.delete(record.id);
      clearTimeout(record.idleTimer);
      return { record, results };
    }
    for (const record of pool.values()) {
      if (!compatible(record, agent, toolConfig, messages)) continue;
      const tail = messages.slice(record.historyLength);
      if (tail.some((message) => message.role === 'assistant' || message.role === 'tool') ||
          !tail.some((message) => message.role === 'user')) continue;
      const prompt = renderConversation({ messages: tail }, {
        nativeTools: request.nativeTools, continuation: true,
        imageCount: request.images.filter((image) => image.index >= record.historyLength).length,
      });
      pool.delete(record.id);
      clearTimeout(record.idleTimer);
      return { record, prompt, images: request.images.filter((image) => image.index >= record.historyLength) };
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

    let request;
    try { request = parseChatRequest(JSON.parse(init.body), { nativeTools: Boolean(bridge) }); }
    catch (error) { return jsonError(400, error.message); }
    const agent = localModels().find(({ id }) => request.model.startsWith(`${id}-`));
    if (!agent) return jsonError(404, 'This local CLI is unavailable. Install it and sign in from the terminal.');
    const native = request.model.slice(agent.id.length + 1);
    if (!/^[a-zA-Z0-9._-]{1,96}$/.test(native)) return jsonError(400, 'Invalid native model ID.');
    const model = native === 'default' ? undefined : native;
    if (request.toolMode && !bridge) return jsonError(503, 'This host cannot serve tools for local CLI models.');

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
          active.usage = undefined;
          void active.session.prompt(prompt, images).then(
            (reason) => active.relay.push({ type: 'end', reason }),
            (error) => active.relay.push({ type: 'error', error }),
          );
        };
        const fresh = async () => begin(await openTurn(agent.id, model, request, toolConfig), request.prompt);
        const claimed = claimTurn(agent.id, model, toolConfig, request);
        const nextModel = model !== undefined && claimed.record && claimed.record.model !== model ? model : undefined;
        const nextEffort = request.effort !== undefined && claimed.record && claimed.record.effort !== request.effort
          ? request.effort : undefined;
        if (!claimed.record) {
          await fresh();
        } else {
          active = claimed.record;
          active.counted = true;
          running++;
          // A result the bridge no longer holds means that turn expired while
          // the caller was away, so the transcript is replayed instead.
          const delivered = claimed.results?.every((result) => bridge.answer(result.tool_call_id, plainText(result.content) ?? ''));
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
          active.historyLength = messages.length + 1;
          active.historyHash = fingerprint([...messages, message]);
          if (message.tool_calls?.length) park(active, message.tool_calls);
          else if (['completed', 'end_turn', 'stop', 'max_tokens', 'max_turn_requests'].includes(outcome.reason)) keepIdle(active);
          else release(active);
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
        type: 'api', keyless: true, label: 'Use locally signed-in CLIs',
        labels: { zh: '使用本机 CLI 登录', 'zh-TW': '使用本機 CLI 登入' },
        async authorize() {
          if (!localModels().length) return { type: 'failed', error: 'No supported local CLI executable was found.' };
          return { type: 'success', key: linkMarker };
        },
      }],
      async loader(getAuth) {
        if ((await getAuth())?.key !== linkMarker) return {};
        return { baseURL, fetch: fetchLocal };
      },
    },
  };
}
