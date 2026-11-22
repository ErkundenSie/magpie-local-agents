import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const log = process.argv[2];
const mode = () => readFileSync(join(log, 'mode'), 'utf8');
const record = (entry) => appendFileSync(join(log, 'wire.jsonl'), `${JSON.stringify(entry)}\n`);
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
let sessionId;
let endpoint;
let model = 'fixture-a';
let effort = 'low';

const configs = () => [
  { id: 'model', category: 'model', currentValue: model, options: [{ value: 'fixture-a' }, { value: 'fixture-b' }] },
  { id: 'thought', category: 'thought_level', currentValue: effort, options: [{ value: 'low' }, { value: 'high' }] },
];
const update = (text) => send({ method: 'session/update', params: { sessionId,
  update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });

async function bridge(method, params) {
  const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify({ method, params }) });
  return (await response.json()).result;
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {
      sessionCapabilities: mode() === 'unsupported' ? {} : { resume: {} }, promptCapabilities: { image: true },
    } } });
  } else if (method === 'session/new' || method === 'session/resume') {
    record({ method, sessionId: params.sessionId, cwd: params.cwd });
    if (method === 'session/resume' && mode() === 'reject') {
      send({ id, error: { code: -32603, message: 'Native history no longer exists' } });
      continue;
    }
    sessionId = params.sessionId ?? randomUUID();
    endpoint = params.mcpServers[0]?.env.find(({ name }) => name === 'MAGPIE_LOCAL_CLI_MCP')?.value;
    if (params.sessionId) update('historical replay chunk');
    send({ id, result: { sessionId, configOptions: configs() } });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'model') model = params.value;
    if (params.configId === 'thought') effort = params.value;
    send({ id, result: { configOptions: configs() } });
  } else if (method === 'session/prompt') {
    const prompt = params.prompt[0].text;
    record({ method, sessionId, endpoint, cwd: process.cwd(), model, effort, prompt, imageCount: params.prompt.length - 1 });
    const replay = prompt.includes('"role":"tool"');
    if (endpoint && prompt.includes('use fixture tool') && !replay) {
      const catalog = await bridge('tools/list');
      const result = await bridge('tools/call', { name: catalog.tools[0].name, arguments: {} });
      update(result.content[0].text);
    } else {
      update(replay ? 'replayed tool result' : 'fixture answer');
    }
    send({ id, result: { stopReason: prompt.includes('exceed turn length') ? 'max_tokens' : 'end_turn' } });
  } else if (method === 'session/close') {
    send({ id, result: {} });
  }
}
