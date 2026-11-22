import { randomUUID } from 'node:crypto';
import { Rpc } from './rpc.mjs';

const maxTurnMs = 30 * 60 * 1000;
const safeMode = /^(default|ask|always[-_ ]?ask|on[-_ ]?request|plan|read[-_ ]?only)$/i;
const toolServer = 'local_cli_tools';

function boundedText(value, size = 4096) {
  return typeof value === 'string' ? value.slice(0, size) : '';
}

// clientToolOf recognises an approval request for one of the caller's tools.
// CLIs spell an MCP call as `mcp(server/tool)`, `server/tool` or
// `mcp_server_tool`; anything else is not the caller's to approve.
function clientToolOf(call, tools) {
  const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const value of [call?.name, call?.title, call?.toolName]) {
    if (typeof value !== 'string') continue;
    const text = value.trim().replace(/\?$/, '');
    for (const { function: definition } of tools) {
      if (text === definition.name) return definition.name;
      // `mcp(server/tool)`, `server/tool`, `server__tool` and `mcp_server_tool`
      // are the shapes CLIs use; the separator run varies.
      const named = new RegExp(`(?:^|[\\s(])${escaped(toolServer)}[\\\\/_.-]+${escaped(definition.name)}(?:$|[)\\s])`, 'i');
      if (named.test(text)) return definition.name;
    }
  }
  return null;
}

const isTokenCount = (value) => Number.isSafeInteger(value) && value >= 0;

function completionUsage(input, output, cached, reasoning, cacheWrite) {
  const total = input + output;
  if (!isTokenCount(input) || !isTokenCount(output) || !isTokenCount(total)) return undefined;
  const usage = { prompt_tokens: input, completion_tokens: output, total_tokens: total };
  const promptDetails = {};
  if (isTokenCount(cached) && cached <= input) promptDetails.cached_tokens = cached;
  if (isTokenCount(cacheWrite) && cacheWrite <= input - (promptDetails.cached_tokens ?? 0)) {
    promptDetails.cache_write_tokens = cacheWrite;
  }
  if (Object.keys(promptDetails).length) usage.prompt_tokens_details = promptDetails;
  if (isTokenCount(reasoning) && reasoning <= output) usage.completion_tokens_details = { reasoning_tokens: reasoning };
  return usage;
}

function acpUsage(reported, agent) {
  if (!reported) return undefined;
  let { inputTokens: input, outputTokens: output } = reported;
  if (!isTokenCount(input) || !isTokenCount(output)) return undefined;
  const { totalTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens } = reported;
  const cache = (isTokenCount(cachedReadTokens) ? cachedReadTokens : 0) +
    (isTokenCount(cachedWriteTokens) ? cachedWriteTokens : 0);
  // Claude and Antigravity can report uncached input. Gemini can report
  // output excluding thoughts. Only fold counts in when the total confirms it.
  if ((agent === 'claude' || agent === 'antigravity') && totalTokens === input + output + cache) input += cache;
  if (agent === 'gemini' && isTokenCount(thoughtTokens) && totalTokens === input + output + thoughtTokens) output += thoughtTokens;
  if (isTokenCount(totalTokens) && totalTokens !== input + output) return undefined;
  return completionUsage(input, output, cachedReadTokens, thoughtTokens, cachedWriteTokens);
}

export class AgentSession {
  #approvals = new Map();
  #rpc;
  #emit;
  #gateway;
  #model;
  #modelConfig;
  #availableModels = [];
  #mcp = [];
  #clientTools = false;
  #tools = [];
  #codexTokenTotal;
  #imageCapability = false;
  #effort;
  #effortConfig;
  // Set by the gateway while a caller's tool call is parked.
  onToolCall;

  constructor(agent, launch, emit, { gateway = false, model, mcpServers = [], clientTools = false, tools = [] } = {}) {
    this.#gateway = gateway;
    this.#model = model;
    this.#mcp = mcpServers;
    this.#clientTools = clientTools;
    this.#tools = tools;
    this.agent = agent;
    this.cwd = launch.cwd;
    this.#emit = emit;
    this.#rpc = new Rpc(launch);
    this.#rpc.onNotification = (method, params) => this.#notify(method, params);
    this.#rpc.onRequest = (method, params) => this.#handleRequest(method, params);
    this.#rpc.onClose = (error) => {
      this.clearApprovals();
      this.completeNativeTurn(error);
    };
  }

  get closed() { return this.#rpc.closed; }

  setSink(sink) { this.#emit = sink; }

  async start() {
    if (this.agent === 'codex') {
      this.#imageCapability = true;
      await this.#rpc.request('initialize', { clientInfo: { name: 'magpie-local-agents', title: 'Magpie Local CLI', version: '0.1.0' } });
      this.#rpc.notify('initialized');
      const { config } = await this.#rpc.request('config/read', { cwd: this.cwd, includeLayers: false });
      if (!config || config.model_provider !== 'openai' || config.openai_base_url ||
          (config.chatgpt_base_url && config.chatgpt_base_url !== 'https://chatgpt.com/backend-api/')) {
        throw new Error('Codex did not resolve to native OpenAI routing. Check its effective provider settings.');
      }
      if (this.#gateway) {
        // Every server the CLI would start must be this plugin's own bridge or
        // the empty stand-in that replaces a user's server.
        const foreign = Object.entries(config.mcp_servers ?? {}).filter(([, entry]) => {
          const args = JSON.stringify(entry?.args ?? []);
          return !/(?:empty-mcp|mcp-stdio)\.mjs/.test(args);
        });
        if (foreign.length) {
          throw new Error(`Codex still has MCP servers that are not isolated: ${foreign.map(([name]) => name).join(', ')}.`);
        }
      }
      // The native route takes a native model id; a host-written catalogue
      // (magpie's model list) names models as `<provider>/<model>`.
      const model = this.#model ?? await this.#nativeModel(config);
      const response = await this.#rpc.request('thread/start', {
        cwd: this.cwd, modelProvider: 'openai',
        sandbox: this.#gateway ? 'read-only' : 'workspace-write',
        approvalPolicy: 'never',
        ...(this.#gateway ? { ephemeral: true } : {}),
        ...(model ? { model } : {}),
      });
      if (model && response?.model !== model) throw new Error('Codex did not select the requested model.');
      this.sessionId = response?.thread?.id;
      if (response?.modelProvider && response.modelProvider !== 'openai') {
        throw new Error('Codex selected a non-OpenAI provider. Use the native OpenAI provider for this session.');
      }
    } else {
      const protocol = await this.#rpc.request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'magpie-local-agents', title: 'Magpie Local CLI', version: '0.1.0' },
        clientCapabilities: {},
      });
      if (protocol?.protocolVersion !== 1) throw new Error('This CLI did not negotiate ACP version 1.');
      this.#imageCapability = protocol?.promptCapabilities?.image === true ||
        protocol?.promptCapabilities?.image?.supported === true;
      // ACP carries a stdio server's environment as {name, value} entries.
      const parameters = {
        cwd: this.cwd,
        mcpServers: this.#mcp.map(({ name, command, args, env }) => ({
          name, command, args,
          env: Object.entries(env ?? {}).map(([key, value]) => ({ name: key, value })),
        })),
      };
      if (this.#gateway && this.agent === 'claude') {
        parameters._meta = { claudeCode: { options: {
          // `tools: []` drops the built-ins; `disallowedTools: ['*']` would also
          // drop the caller's MCP tools, so it is only used without them.
          tools: [], ...(this.#clientTools ? {} : { disallowedTools: ['*'] }),
          settingSources: [], ...(this.#clientTools ? {} : { extraArgs: { 'strict-mcp-config': null } }),
          settings: { disableAllHooks: true },
        } } };
      }
      const response = await this.#rpc.request('session/new', parameters);
      this.sessionId = response?.sessionId;
      if (this.sessionId) {
        await this.#setSafeMode(response);
        const configs = Array.isArray(response.configOptions) ? response.configOptions : [];
        this.#modelConfig = configs.find((option) => option.category === 'model');
        this.#effortConfig = configs.find((option) => option.category === 'thought_level') ??
          configs.find((option) => /effort|reasoning|thought/i.test(`${option.id} ${option.category ?? ''}`));
        const choices = this.#modelConfig?.options?.flatMap((item) => item.options ?? [item]);
        this.#availableModels = choices?.map(({ value, name }) => ({ id: value, name })) ??
          response.models?.availableModels?.map(({ modelId, name }) => ({ id: modelId, name })) ?? [];
        if (this.#model) await this.#setModel(response);
      }
    }
    if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error('The CLI did not return a session ID.');
    this.#emit({ type: 'session', sessionId: this.sessionId });
  }

  async #setSafeMode(response) {
    const config = response.configOptions?.find((option) => option.category === 'mode');
    const current = config?.currentValue ?? response.modes?.currentModeId;
    const available = config?.options?.flatMap((item) => item.options ?? [item]);
    const choices = available?.map((option) => option.value) ?? response.modes?.availableModes?.map((mode) => mode.id) ?? [];
    const restrained = this.#gateway && !this.#clientTools && choices.find((id) => /^(plan|read[-_ ]?only)$/i.test(id));
    if ((!current || safeMode.test(current)) && (!restrained || current === restrained)) return;
    const preferred = restrained || (choices.find((id) => /^(default|ask|always[-_ ]?ask|on[-_ ]?request)$/i.test(id)) ?? choices.find((id) => safeMode.test(id)));
    if (!preferred) throw new Error('The CLI did not offer an approval mode supported by this plugin. Set its default mode to ask for approval.');
    if (config) {
      await this.#rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: config.id, value: preferred });
    } else {
      await this.#rpc.request('session/set_mode', { sessionId: this.sessionId, modeId: preferred });
    }
  }

  async listModels() {
    if (this.agent !== 'codex') return this.#availableModels;
    const { data } = await this.#rpc.request('model/list', { modelProvider: 'openai', includeHidden: false, limit: 80 }, 8000);
    const native = new Map();
    for (const entry of data ?? []) {
      if (typeof entry?.model !== 'string') continue;
      // `codex/x` and `openai/x` are the ChatGPT/API models of a host-written
      // catalogue; other namespaces belong to that host, not to this CLI.
      const [namespace, rest] = entry.model.includes('/') ? entry.model.split('/', 2) : [null, entry.model];
      if (namespace && !/^(codex|openai)$/i.test(namespace)) continue;
      if (!/^[a-zA-Z0-9._-]{1,96}$/.test(rest)) continue;
      if (!native.has(rest)) native.set(rest, { id: rest, name: entry.displayName || rest });
    }
    return [...native.values()];
  }

  // #nativeModel is the model a native OpenAI route accepts: the configured
  // one when it is already a plain id, else the first native id the account
  // offers. Nothing when the configuration is usable as it stands.
  async #nativeModel(config) {
    const configured = typeof config?.model === 'string' ? config.model : '';
    if (!configured.includes('/')) return undefined;
    const wanted = configured.slice(configured.indexOf('/') + 1);
    const offered = await this.listModels().catch(() => []);
    return offered.some(({ id }) => id === wanted) ? wanted : offered[0]?.id;
  }

  // setEffort applies a reasoning level to a running session. Codex takes it
  // per turn; ACP exposes it as a configuration option. A CLI that does not
  // offer the level keeps its own default rather than failing the request.
  async setEffort(effort) {
    if (effort === this.#effort) return;
    const previous = this.#effort;
    this.#effort = effort;
    if (this.agent === 'codex' || effort === undefined) return;
    const config = this.#effortConfig;
    const offered = config?.options?.flatMap((option) => option.options ?? [option]).map((option) => option.value);
    if (!offered?.includes(effort)) return;
    try {
      const result = await this.#rpc.request('session/set_config_option', {
        sessionId: this.sessionId, configId: config.id, value: effort,
      });
      const selected = result?.configOptions?.find((option) => option.id === config.id)?.currentValue;
      if (selected !== effort) this.#effort = previous;
    } catch {
      this.#effort = previous;
    }
  }

  // setModel switches the model of a session that is already running, so a
  // caller that changes models mid-conversation keeps its context. Codex takes
  // the model per turn; ACP switches it through a configuration option.
  async setModel(model) {
    if (model === this.#model) return;
    const previous = this.#model;
    this.#model = model;
    if (this.agent === 'codex') return;
    // Without a model the CLI keeps whatever it already uses.
    if (model === undefined) return;
    try {
      await this.#setModel({});
    } catch (error) {
      this.#model = previous;
      throw error;
    }
  }

  async #setModel(response) {
    const config = this.#modelConfig;
    if ((config?.currentValue ?? response.models?.currentModelId) === this.#model) return;
    if (!this.#availableModels.some(({ id }) => id === this.#model)) {
      throw new Error(`The native CLI does not offer ${this.#model} for its current login.`);
    }
    if (config) {
      const result = await this.#rpc.request('session/set_config_option', {
        sessionId: this.sessionId, configId: config.id, value: this.#model,
      });
      const selected = result?.configOptions?.find((option) => option.id === config.id)?.currentValue;
      if (selected !== this.#model) throw new Error('The native CLI did not confirm the requested model.');
    } else {
      await this.#rpc.request('session/set_model', { sessionId: this.sessionId, modelId: this.#model });
    }
  }

  async prompt(text, images = []) {
    if (this.agent !== 'codex') {
      if (images.length && !this.#imageCapability) {
        throw Object.assign(new Error('This CLI does not accept image input over ACP.'), { status: 400 });
      }
      const prompt = [{ type: 'text', text }];
      for (const image of images) prompt.push({ type: 'image', mimeType: image.mimeType, data: image.data });
      const result = await this.#rpc.request('session/prompt', { sessionId: this.sessionId, prompt }, maxTurnMs)
        .catch((error) => {
          // A cancelled ACP turn is not a dead process. Its usage may be
          // partial, but it must not leave a reusable session looking lost.
          if (error.message !== 'The CLI turn was cancelled.') throw error;
          if (this.#rpc.closed) throw error;
          return { stopReason: 'cancelled' };
        });
      const grokUsage = this.agent === 'grok' ? result?._meta?.usage : undefined;
      const usage = acpUsage(result?.usage, this.agent) ?? (grokUsage && acpUsage({
        ...grokUsage, thoughtTokens: grokUsage.reasoningTokens, cachedWriteTokens: grokUsage.cacheCreationTokens,
      }, this.agent));
      if (usage) this.#emit({ type: 'usage', usage });
      return result?.stopReason ?? 'end_turn';
    }

    const turn = { cancelRequested: false, tokenBaseline: this.#codexTokenTotal };
    this.nativeTurn = turn;
    const finished = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
      turn.timer = setTimeout(() => this.completeNativeTurn(new Error('The Codex turn timed out.')), maxTurnMs);
    });
    // A turn can complete or the process can exit before turn/start returns.
    finished.catch(() => {});
    try {
      const input = [{ type: 'text', text, text_elements: [] }];
      // Codex accepts images only as inline data URLs, never as remote ones.
      for (const image of images) input.push({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` });
      const response = await this.#rpc.request('turn/start', {
        threadId: this.sessionId, input,
        ...(this.#model ? { model: this.#model } : {}),
        ...(this.#effort ? { effort: this.#effort } : {}),
      });
      if (this.nativeTurn === turn) {
        turn.id ??= response?.turn?.id;
        if (!turn.id) throw new Error('Codex did not return a turn ID.');
        if (turn.cancelRequested) void this.#interrupt(turn);
      }
      return await finished;
    } catch (error) {
      if (this.nativeTurn === turn) this.completeNativeTurn(error);
      throw error;
    }
  }

  completeNativeTurn(error, status) {
    const turn = this.nativeTurn;
    if (!turn) return;
    this.nativeTurn = undefined;
    clearTimeout(turn.timer);
    if (error) {
      turn.reject(error);
      return;
    }
    if (turn.tokenTotal) {
      const delta = (key) => isTokenCount(turn.tokenTotal[key])
        ? turn.tokenTotal[key] - (turn.tokenBaseline?.[key] ?? 0)
        : undefined;
      const usage = completionUsage(delta('inputTokens'), delta('outputTokens'),
        delta('cachedInputTokens'), delta('reasoningOutputTokens'));
      if (usage) this.#emit({ type: 'usage', usage });
    }
    turn.resolve(status);
  }

  async #interrupt(turn) {
    if (turn.interrupting || this.nativeTurn !== turn) return;
    turn.interrupting = true;
    try { await this.#rpc.request('turn/interrupt', { threadId: this.sessionId, turnId: turn.id }, 5000); }
    catch { this.close(); }
  }

  cancel() {
    this.clearApprovals();
    if (!this.sessionId) return this.close();
    if (this.agent !== 'codex') return this.#rpc.notify('session/cancel', { sessionId: this.sessionId });
    if (this.nativeTurn) {
      this.nativeTurn.cancelRequested = true;
      if (this.nativeTurn.id) void this.#interrupt(this.nativeTurn);
    }
  }

  close() {
    this.#rpc.close();
    this.clearApprovals();
  }

  decide(id, optionId) {
    const approval = this.#approvals.get(id);
    if (approval?.options.some((option) => option.id === optionId)) approval.finish(optionId);
  }

  clearApprovals() {
    for (const approval of this.#approvals.values()) approval.finish(null);
  }

  #ask(title, detail, options) {
    if (!options.length) return null;
    const id = randomUUID();
    return new Promise((resolve) => {
      const finish = (option) => {
        clearTimeout(timer);
        this.#approvals.delete(id);
        this.#emit({ type: 'resolved', id });
        resolve(option);
      };
      const timer = setTimeout(() => finish(null), 120000);
      this.#approvals.set(id, { options, finish });
      this.#emit({ type: 'permission', id, title, detail, options });
    });
  }

  async #handleRequest(method, params) {
    if (this.agent !== 'codex') {
      if (method !== 'session/request_permission') return undefined;
      if (!this.sessionId || params.sessionId !== this.sessionId) return { outcome: { outcome: 'cancelled' } };
      if (this.#gateway) {
        // Only the caller's own tools are approved; the CLI's built-ins, any
        // global MCP server and anything else is refused for this turn.
        const allowed = this.#clientTools ? clientToolOf(params.toolCall, this.#tools) : null;
        const allow = allowed && params.options?.find((option) => option.kind === 'allow_once');
        if (allow) return { outcome: { outcome: 'selected', optionId: allow.optionId } };
        const reject = params.options?.find((option) => option.kind === 'reject_once');
        return { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } };
      }
      const options = (params.options ?? []).filter((option) => ['allow_once', 'reject_once'].includes(option.kind))
        .map((option) => ({ id: option.optionId, label: boundedText(option.name, 100), kind: option.kind }));
      const title = boundedText(params.toolCall?.title) || 'Approve tool call?';
      const input = params.toolCall?.rawInput;
      const detail = boundedText(input === undefined ? '' : typeof input === 'string' ? input : JSON.stringify(input, null, 2));
      const optionId = await this.#ask(title, detail, options);
      return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
    }

    if (method === 'item/permissions/requestApproval') {
      // The native workspace policy already covers ordinary edits. Broader access is declined.
      return { permissions: {}, scope: 'turn' };
    }
    if (method === 'item/tool/requestUserInput') return { answers: {} };
    if (method === 'mcpServer/elicitation/request') return { action: 'decline' };
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) return undefined;
    if (this.#gateway || !this.nativeTurn || params.threadId !== this.sessionId) return { decision: 'decline' };
    const command = method === 'item/commandExecution/requestApproval';
    const options = [{ id: 'decline', label: 'Decline', kind: 'reject_once' }];
    if (!params.availableDecisions || params.availableDecisions.includes('accept')) {
      options.unshift({ id: 'accept', label: 'Allow once', kind: 'allow_once' });
    }
    const detail = [params.command, params.reason, params.grantRoot].map((value) => boundedText(value)).filter(Boolean).join('\n');
    const selected = await this.#ask(command ? 'Approve Codex command?' : 'Approve Codex file change?', detail, options);
    return { decision: selected ?? 'decline' };
  }

  #notify(method, params) {
    if (this.agent !== 'codex') {
      if (method !== 'session/update' || params.sessionId !== this.sessionId) return;
      const update = params.update;
      if (!update) return;
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk':
          if (update.content?.type === 'text') this.#emit({ type: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', text: update.content.text });
          break;
        case 'tool_call':
        case 'tool_call_update':
          this.#emit({ type: 'tool', id: update.toolCallId, title: boundedText(update.title), status: update.status });
          break;
      }
      return;
    }

    const turn = this.nativeTurn;
    if (!turn || params.threadId !== this.sessionId || (params.turnId && turn.id && params.turnId !== turn.id)) return;
    switch (method) {
      case 'thread/tokenUsage/updated': {
        // `total` is cumulative for the thread. `last` only describes one
        // model response, so it misses earlier steps in a tool-using turn.
        const total = params.tokenUsage?.total;
        if (isTokenCount(total?.inputTokens) && isTokenCount(total?.outputTokens)) {
          turn.tokenTotal = total;
          this.#codexTokenTotal = total;
        }
        break;
      }
      case 'turn/started':
        turn.id = params.turn?.id;
        if (turn.id && turn.cancelRequested) void this.#interrupt(turn);
        break;
      case 'turn/completed': {
        const status = params.turn?.status ?? 'completed';
        this.completeNativeTurn(status === 'failed' ? new Error(params.turn?.error?.message || 'Codex reported a failed turn.') : null, status);
        break;
      }
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        if (typeof params.delta === 'string') this.#emit({ type: method === 'item/agentMessage/delta' ? 'text' : 'thought', text: params.delta });
        break;
      case 'item/started':
      case 'item/completed': {
        const item = params.item;
        if (!item) break;
        const labels = { commandExecution: item.command, fileChange: 'File change', mcpToolCall: item.tool, webSearch: item.query };
        if (Object.hasOwn(labels, item.type)) this.#emit({ type: 'tool', id: item.id, title: boundedText(labels[item.type]), status: item.status ?? (method === 'item/started' ? 'in_progress' : 'completed') });
        break;
      }
    }
  }
}
