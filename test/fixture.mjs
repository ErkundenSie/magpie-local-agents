import { createInterface } from 'node:readline';

const native = process.argv[2] === 'codex';
let turns = 0;
let currentModel;
let currentEffort;
let threadStart;
const models = (process.argv[3] === 'catalog'
  ? ['agy-pro-low', 'agy-pro-high', 'agy-pro-max', 'agy-flash-low', 'agy-flash', 'gemini-4-neon-high']
  : ['model-a', 'model-b']).map((value) => ({ value }));
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const reply = (id, result) => send({ id, result });
const lines = createInterface({ input: process.stdin });
const approvals = new Map();
for await (const line of lines) {
  const { method, id, params, result } = JSON.parse(line);
  switch (method) {
    case 'initialize': reply(id, native
      ? { userAgent: 'fixture' }
      : { protocolVersion: 1, promptCapabilities: { image: process.argv[3] === 'object-image' ? { supported: true } : process.argv[3] !== 'no-image' } }); break;
    case 'initialized': break;
    case 'config/read': reply(id, { config: { model_provider: 'openai', openai_base_url: '' } }); break;
    case 'account/read': reply(id, { account: { type: 'chatgpt', email: 'fixture@example.invalid' }, requiresOpenaiAuth: true }); break;
    case 'session/new': reply(id, { sessionId: 'acp-session', configOptions: [
      { id: 'model', category: 'model', currentValue: models[0].value, options: models },
      ...(process.argv[3] === 'catalog' ? [] : [{
        id: 'thought_level', category: 'thought_level', currentValue: 'medium',
        options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
      }]),
    ] }); break;
    case 'session/set_config_option': {
      if (params.configId === 'thought_level') currentEffort = params.value;
      else currentModel = params.value;
      const configs = [
        { id: 'model', category: 'model', currentValue: currentModel ?? 'model-a', options: models },
        ...(process.argv[3] === 'catalog' && currentModel !== 'agy-flash' ? [] : [{
          id: 'thought_level', category: 'thought_level', currentValue: currentEffort ?? 'medium',
          options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
        }]),
      ];
      reply(id, { configOptions: configs });
      break;
    }
    case 'thread/start':
      threadStart = params;
      reply(id, { thread: { id: 'native-thread' }, modelProvider: 'openai' });
      break;
    case 'turn/start': {
      const turn = { id: `turn-${++turns}`, status: 'completed' };
      const first = params.input?.[0]?.text ?? '';
      // A thread-mode turn reports the isolation flags from thread/start.
      const text = process.argv[3] === 'thread'
        ? `sandbox:${threadStart?.sandbox} ephemeral:${threadStart?.ephemeral} approval:${threadStart?.approvalPolicy}`
        : first.startsWith('probe')
        ? params.input.map((item) => item.type === 'image'
          ? `image:${String(item.url).slice(0, 22)}` : item.type).join(',') +
          (params.model ? ` model:${params.model}` : '') + (params.effort ? ` effort:${params.effort}` : '')
        : `回合 ${turns}`;
      send({ method: 'item/agentMessage/delta', params: { threadId: 'native-thread', turnId: turn.id, delta: text } });
      send({ method: 'turn/completed', params: { threadId: 'native-thread', turn } });
      reply(id, { turn });
      break;
    }
    case 'session/prompt': {
      const turn = ++turns;
      const first = params.prompt[0]?.text ?? '';
      // A probe turn reports back how the prompt's content blocks arrived.
      if (process.argv[3] === 'catalog') {
        for (const [sessionUpdate, text] of [['agent_thought_chunk', 'summary'], ['agent_message_chunk', [currentModel ?? 'default', currentEffort].filter(Boolean).join(':')]]) {
          send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
            sessionUpdate, content: { type: 'text', text },
          } } });
        }
        reply(id, { stopReason: 'end_turn' });
        break;
      }
      if (first.startsWith('probe')) {
        const kinds = params.prompt.map((part) => part.type === 'image'
          ? `image:${part.mimeType}:${String(part.data).slice(0, 4)}` : part.type).join(',');
        const model = currentModel ? ` model:${currentModel}` : '';
        const effort = currentEffort ? ` effort:${currentEffort}` : '';
        send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: kinds + model + effort },
        } } });
        reply(id, { stopReason: 'end_turn' });
        break;
      }
      // A text-only retry (the plugin's own nudge) is answered normally.
      if (process.argv[3] === 'cancelled' && first.includes('Do not call any tool')) {
        send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'retried as text' },
        } } });
        reply(id, { stopReason: 'end_turn' });
        break;
      }
      if (first === 'wait') {
        if (process.argv[3] === 'cancelled') {
          reply(id, { stopReason: 'cancelled' });
          break;
        }
        break;
      }
      const agyMode = process.argv[3];
      const agyPermission = ['agy-allow', 'agy-denied', 'agy-still-empty'].includes(agyMode);
      const toolCall = agyPermission
        ? { name: agyMode === 'agy-allow' || turn > 1 ? 'mcp_local_cli_tools_lookup' : 'read_file' }
        : process.argv[3] === 'allow' ? { name: 'lookup', title: 'lookup' } : { title: 'Read the fixture' };
      send({ id: `approve-${id}`, method: 'session/request_permission', params: {
        sessionId: 'acp-session',
        toolCall,
        options: [
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'no', name: 'Decline', kind: 'reject_once' },
          { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
        ],
      } });
      approvals.set(`approve-${id}`, { id, turn, agyMode, first });
      break;
    }
    case 'session/cancel':
      if (process.argv[3] === 'cancelled') {
        // The real Grok closes the prompt this way and leaves the process alive.
        reply(id, { stopReason: 'cancelled' });
        break;
      }
      process.exit(0);
      break;
    default: {
      const approval = approvals.get(id);
      if (approval) {
        approvals.delete(id);
        const option = result?.outcome?.optionId;
        if (['agy-denied', 'agy-still-empty'].includes(approval.agyMode)) {
          const first = approval.turn === 1;
          const recovered = !first && option === 'no' &&
            approval.first.includes('Reply with text only.') && !approval.first.includes('original question') &&
            approval.agyMode === 'agy-denied';
          send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
            sessionUpdate: recovered ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: { type: 'text', text: recovered ? 'recovered as text' : `thought after ${option}` },
          } } });
          reply(approval.id, { stopReason: 'end_turn' });
          break;
        }
        send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `回合 ${approval.turn}: ${result?.outcome?.optionId}` },
        } } });
        send({ method: 'session/update', params: { sessionId: 'acp-session', update: {
          sessionUpdate: 'usage_update', used: 999, size: 2000,
          ...(process.argv[2] === 'claude' && { _meta: { '_claude/rateLimit': {
            five_hour: { utilization: 42, resets_at: '2026-11-22T06:00:00Z' },
            seven_day: { utilization: 12.5, resets_at: '2026-11-27T00:00:00Z' },
          } } }),
        } } });
        const usage = process.argv[2] === 'grok'
          ? { _meta: { totalTokens: 999, usage: {
            inputTokens: 30, outputTokens: 10, cachedReadTokens: 12, cacheCreationTokens: 3, reasoningTokens: 6, totalTokens: 40,
          } } }
          // ACP agents report uncached input next to the cache counts; the total
          // is what confirms how the plugin should fold them.
          : { usage: { inputTokens: 18, outputTokens: 10, thoughtTokens: 6, cachedReadTokens: 12, totalTokens: 40 } };
        reply(approval.id, { stopReason: 'end_turn', ...(approval.turn === 1 && usage) });
      } else if (id !== undefined && method) {
        send({ id, error: { code: -32601, message: 'Unsupported fixture method' } });
      }
    }
  }
}
