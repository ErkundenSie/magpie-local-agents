import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerHooks } from '../lib/provider.mjs';
import { ToolBridge } from '../lib/tool-bridge.mjs';

const fixture = fileURLToPath(new URL('fixture-agy-resume.mjs', import.meta.url));
const tools = [{ type: 'function', function: { name: 'lookup', description: 'Fixture tool' } }];
const user = (content) => ({ role: 'user', content });
const first = user('opening transcript sentinel');
const followUp = user('next question');
const reply = (response) => response.choices[0].message;

async function withFixture(run, { ttlMs, cli = 'antigravity' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'magpie-agy-resume-test-'));
  const directory = join(root, 'state');
  const hosts = [];
  const mode = (value) => writeFileSync(join(root, 'mode'), value);
  mode('supported');
  writeFileSync(join(root, '.local-agents.json'), JSON.stringify({
    executables: { [cli]: { path: process.execPath, args: [fixture, root] } },
  }));

  async function start() {
    const bridge = new ToolBridge({ getPort: () => server.port });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
      fetch: (request) => bridge.handle(request, new URL(request.url).pathname.split('/').at(-1)),
    });
    const hooks = providerHooks(root, { bridge, agyResume: { directory, ttlMs } });
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    let stopping;
    const host = {
      async chat(messages, body = {}, session = 'test-chat') {
        const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
          method: 'POST', headers: { 'x-magpie-session': session },
          body: JSON.stringify({ model: `${cli}-default`, messages, ...body }),
        });
        expect(response.status).toBe(200);
        return body.stream ? response.text() : response.json();
      },
      stop() {
        stopping ??= hooks.stop().finally(() => server.stop(true));
        return stopping;
      },
    };
    hosts.push(host);
    return host;
  }

  const wire = () => readFileSync(join(root, 'wire.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const prompts = () => wire().filter(({ method }) => method === 'session/prompt');
  const saved = () => {
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap((install) => {
      const scoped = join(directory, install);
      return readdirSync(scoped).filter((file) => file.endsWith('.json')).map((file) => readFileSync(join(scoped, file), 'utf8'));
    });
  };
  try { await run({ start, mode, wire, prompts, saved }); }
  finally {
    await Promise.all(hosts.map((host) => host.stop()));
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const timeout = 30000;

test('only one fork resumes a completed turn after gateway restart', () => withFixture(async ({ start, wire, prompts, saved }) => {
  const host = await start();
  const opening = { role: 'user', content: [{ type: 'text', text: first.content },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] };
  const streamed = await host.chat([opening], { stream: true, model: 'antigravity-fixture-b', reasoning_effort: 'high' });
  expect(streamed).toContain('[DONE]');
  expect(saved()).toHaveLength(1);
  expect(saved()[0]).not.toContain(first.content);
  expect(saved()[0]).not.toContain('aGVsbG8=');
  await host.stop();
  expect(existsSync(prompts()[0].cwd)).toBe(false);
  const left = await start();
  const right = await start();
  const history = [opening, { role: 'assistant', content: [{ type: 'text', text: 'fixture answer' }] }];
  const responses = await Promise.all([left.chat([...history, user('branch A')]), right.chat([...history, user('branch B')])]);
  expect(responses.map((response) => reply(response).content)).toEqual(['fixture answer', 'fixture answer']);
  const [original, ...forks] = prompts();
  const resumed = forks.find(({ sessionId }) => sessionId === original.sessionId);
  const replayed = forks.find(({ sessionId }) => sessionId !== original.sessionId);
  expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(1);
  expect(resumed.model).toBe('fixture-b');
  expect(resumed.effort).toBe('high');
  expect(resumed.prompt).not.toContain(first.content);
  expect(resumed.imageCount).toBe(0);
  expect(replayed.prompt).toContain(first.content);
  expect(replayed.imageCount).toBe(1);
}), timeout);

test('resumed callers get a fresh tool bridge and can finish a newly parked turn', () => withFixture(async ({ start, prompts, saved }) => {
  const host = await start();
  const opened = await host.chat([first], { tools });
  await host.stop();
  const restarted = await start();
  const messages = [first, reply(opened), user('use fixture tool')];
  const pending = await restarted.chat(messages, { tools });
  expect(pending.choices[0].finish_reason).toBe('tool_calls');
  expect(saved()).toHaveLength(0);
  const call = reply(pending).tool_calls[0];
  const done = await restarted.chat([...messages, reply(pending), { role: 'tool', tool_call_id: call.id, content: 'tool result sentinel' }], { tools });
  expect(reply(done).content).toBe('tool result sentinel');
  const [original, resumed] = prompts();
  expect(resumed.sessionId).toBe(original.sessionId);
  expect(resumed.endpoint).not.toBe(original.endpoint);
  expect(saved()).toHaveLength(1);
  expect(saved()[0]).not.toContain('tool result sentinel');
  expect(saved()[0]).not.toContain(resumed.endpoint);
}), timeout);

test('restart replays an interrupted tool turn and does not recover a truncated turn', () => withFixture(async ({ start, wire, saved }) => {
  const host = await start();
  const messages = [user('use fixture tool')];
  const pending = await host.chat(messages, { tools });
  const call = reply(pending).tool_calls[0];
  await host.stop();
  expect(saved()).toHaveLength(0);
  const restarted = await start();
  const done = await restarted.chat([...messages, reply(pending), { role: 'tool', tool_call_id: call.id, content: 'answer' }], { tools });
  expect(reply(done).content).toBe('replayed tool result');
  const limited = await restarted.chat([user('exceed turn length')]);
  expect(limited.choices[0].finish_reason).toBe('length');
  expect(saved()).toHaveLength(1);
  expect(wire().some(({ method }) => method === 'session/resume')).toBe(false);
}), timeout);

test('edited history, changed tools, and a different caller do not consume the matching checkpoint', () => withFixture(async ({ start, wire, prompts }) => {
  const host = await start();
  const opened = await host.chat([first], { tools, user: 'alice' });
  await host.stop();
  const next = await start();
  const history = [first, reply(opened), followUp];
  await next.chat(history, { tools, user: 'alice' }, 'other-chat');
  await next.chat(history, { tools, user: 'bob' });
  await next.chat(history, { user: 'alice' });
  await next.chat([first, { role: 'assistant', content: 'edited answer' }, followUp], { tools, user: 'alice' });
  expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(0);
  await next.chat(history, { tools, user: 'alice' });
  expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(1);
  expect(prompts().at(-1).sessionId).toBe(prompts()[0].sessionId);
}), timeout);

for (const behavior of ['unsupported', 'reject']) {
  test(`native ${behavior} falls back to transcript replay`, () => withFixture(async ({ start, mode, wire, prompts }) => {
    const host = await start();
    const opened = await host.chat([first]);
    await host.stop();
    mode(behavior);
    const next = await start();
    const done = await next.chat([first, reply(opened), followUp]);
    expect(reply(done).content).toBe('fixture answer');
    expect(prompts()[1].sessionId).not.toBe(prompts()[0].sessionId);
    expect(prompts()[1].prompt).toContain(first.content);
    expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(behavior === 'reject' ? 1 : 0);
  }), timeout);
}

test('expired checkpoints replay after restart', () => withFixture(async ({ start, wire, prompts }) => {
  const host = await start();
  const opened = await host.chat([first]);
  await host.stop();
  await Bun.sleep(35);
  const next = await start();
  await next.chat([first, reply(opened), followUp]);
  expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(0);
  expect(prompts()[1].prompt).toContain(first.content);
}, { ttlMs: 20 }), timeout);

test('a completed Grok turn resumes through the same checkpoint rules', () => withFixture(async ({ start, wire, prompts }) => {
  const host = await start();
  const opened = await host.chat([first]);
  await host.stop();
  const next = await start();
  const done = await next.chat([first, reply(opened), followUp]);
  expect(reply(done).content).toBe('fixture answer');
  expect(wire().filter(({ method }) => method === 'session/resume')).toHaveLength(1);
  expect(prompts()[1].sessionId).toBe(prompts()[0].sessionId);
  expect(prompts()[1].prompt).not.toContain(first.content);
}, { cli: 'grok' }), timeout);
