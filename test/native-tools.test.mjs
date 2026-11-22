import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerHooks } from '../lib/provider.mjs';
import { ToolBridge } from '../lib/tool-bridge.mjs';

const fixture = fileURLToPath(new URL('fixture-tools.mjs', import.meta.url));

// A project whose "codex" is this repository's fixture, run by the same
// runtime as the tests, so no real CLI or account is involved.
function project() {
  const dir = mkdtempSync(join(tmpdir(), 'local-cli-tools-test-'));
  writeFileSync(join(dir, '.local-agents.json'), JSON.stringify({
    executables: { codex: { path: process.execPath, args: [fixture] } },
  }));
  return dir;
}

async function harness() {
  let server;
  const bridge = new ToolBridge({ getPort: () => server.port });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const token = new URL(request.url).pathname.split('/').at(-1);
      return bridge.handle(request, token);
    },
  });
  const hooks = providerHooks(project(), { bridge });
  const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
  const chat = (body) => loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: 'POST', body: JSON.stringify(body),
  });
  return { hooks, chat, stop: () => { hooks.stop(); server.stop(true); } };
}

const tool = {
  type: 'function',
  function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
};

test('a caller tool is offered to the CLI as an MCP tool and its call is parked', async () => {
  const { chat, stop } = await harness();
  try {
    const response = await chat({
      model: 'codex-test-model',
      messages: [{ role: 'user', content: 'look it up' }],
      tools: [tool],
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.usage).toBeUndefined();
    const choice = body.choices[0];
    expect(choice.finish_reason).toBe('tool_calls');
    expect(choice.message.tool_calls).toHaveLength(1);
    const call = choice.message.tool_calls[0];
    expect(call.function.name).toBe('lookup');
    expect(JSON.parse(call.function.arguments)).toEqual({ query: 'fixture' });
    expect(choice.message.content).toContain('before tool');

    const continuation = {
      model: 'codex-test-model',
      messages: [
        { role: 'user', content: 'look it up' }, choice.message,
        { role: 'tool', tool_call_id: call.id, content: 'found 42' },
      ],
      tools: [tool],
    };
    const changedTool = { ...tool, function: { ...tool.function, description: 'A different implementation' } };
    const fork = await chat({ ...continuation, tools: [changedTool] });
    expect((await fork.json()).choices[0].message.content).toBe('done after tool');
    const [user, assistant, result] = continuation.messages;
    const edited = await chat({ ...continuation, messages: [user, { ...assistant, content: 'edited' }, result] });
    expect((await edited.json()).choices[0].message.content).toBe('done after tool');

    // Both divergent requests left the original parked call untouched.
    const resumed = await chat(continuation);
    expect(resumed.status).toBe(200);
    const answer = await resumed.json();
    expect(answer.usage).toEqual({
      prompt_tokens: 200, completion_tokens: 40, total_tokens: 240,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 10 },
    });
    expect(answer.choices[0].finish_reason).toBe('stop');
    expect(answer.choices[0].message.content).toContain('tool said found 42');
  } finally {
    stop();
  }
}, 30000);

test('an image reaches the CLI as an inline data URL and is not resent on a reused session', async () => {
  const { chat, stop } = await harness();
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const withImage = { role: 'user', content: [
    { type: 'text', text: 'probe' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
  ] };
  try {
    const first = await (await chat({ model: 'codex-test-model', messages: [withImage] })).json();
    expect(first.choices[0].message.content).toBe('text,image:data:image/png;base64,');
    // The conversation continues with a text-only message: the image is
    // already inside the CLI's session, so it must not be sent again.
    const second = await (await chat({
      model: 'codex-test-model',
      messages: [withImage, first.choices[0].message, { role: 'user', content: 'probe again' }],
    })).json();
    expect(second.choices[0].message.content).toBe('text');
  } finally {
    stop();
  }
}, 30000);

test('a CLI usage limit surfaces as 429, not as a broken upstream', async () => {
  const { chat, stop } = await harness();
  try {
    const response = await chat({ model: 'codex-test-model', messages: [{ role: 'user', content: 'rate limited please' }] });
    expect(response.status).toBe(429);
    expect((await response.json()).error.message).toContain('usage limit');
  } finally {
    stop();
  }
}, 30000);

test('without caller tools no bridge endpoint is registered', async () => {
  const { chat, stop } = await harness();
  try {
    const response = await chat({ model: 'codex-test-model', messages: [{ role: 'user', content: 'hi' }] });
    const body = await response.json();
    expect(body.choices[0].message.content).toContain('no tool server');
  } finally {
    stop();
  }
}, 30000);
