import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = 'D:/MyWin/Documents/MyCode/magpie-local-agents';
const MODEL = process.argv[2] ?? 'codex-default';
const { providerHooks } = await import(`file:///${root}/lib/provider.mjs`);
const { ToolBridge } = await import(`file:///${root}/lib/tool-bridge.mjs`);

let server;
const bridge = new ToolBridge({ getPort: () => server.port });
server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    return bridge.handle(request, new URL(request.url).pathname.split('/').at(-1));
  },
});
const auth = async () => ({ key: 'local-cli-linked' });
const hooks = providerHooks(root, { bridge });
const loader = await hooks.auth.loader(auth);
const send = (body) => loader.fetch(`${loader.baseURL}/chat/completions`, { method: 'POST', body: JSON.stringify(body) });

const tools = [{
  type: 'function',
  function: { name: 'echo', description: 'Echo text back', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
}];
const messages = [{ role: 'user', content: 'Call the echo tool with text "hi". Then tell me exactly what it returned.' }];

const started = Date.now();
const first = await send({ model: MODEL, messages, tools });
const one = await first.json();
const choice = one.choices?.[0];
console.log(`first: status=${first.status} finish=${choice?.finish_reason} calls=${choice?.message?.tool_calls?.length ?? 0} ${Date.now() - started}ms`);
if (choice?.message?.tool_calls?.length) {
  console.log('call:', JSON.stringify(choice.message.tool_calls[0].function));
  const call = choice.message.tool_calls[0];
  const second = await send({
    model: MODEL,
    messages: [...messages, choice.message, { role: 'tool', tool_call_id: call.id, content: 'echo-42' }],
    tools,
  });
  const two = await second.json();
  console.log(`second: status=${second.status} finish=${two.choices?.[0]?.finish_reason} ${Date.now() - started}ms`);
  console.log('reply:', String(two.choices?.[0]?.message?.content ?? two.error?.message).slice(0, 300));
} else {
  console.log('body:', JSON.stringify(one).slice(0, 400));
}
server.stop(true);
