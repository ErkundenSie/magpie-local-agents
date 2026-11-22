import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerHooks } from '../lib/provider.mjs';
import { ToolBridge } from '../lib/tool-bridge.mjs';

const fixture = fileURLToPath(new URL('fixture-tools.mjs', import.meta.url));

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'local-cli-reuse-test-'));
  writeFileSync(join(dir, '.local-agents.json'), JSON.stringify({
    executables: { codex: { path: process.execPath, args: [fixture] } },
  }));
  const log = join(dir, 'prompts.jsonl');
  process.env.FIXTURE_LOG = log;
  let server;
  const bridge = new ToolBridge({ getPort: () => server.port });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => bridge.handle(request, new URL(request.url).pathname.split('/').at(-1)) });
  const hooks = providerHooks(dir, { bridge });
  return { hooks, bridge, log, stop: () => { hooks.stop(); server.stop(true); delete process.env.FIXTURE_LOG; } };
}

const turns = (log) => {
  try { return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch { return []; }
};

test('a continuing conversation reuses its CLI session and sends only new messages', async () => {
  const { hooks, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const chat = (messages) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'codex-test-model', messages }),
    });
    // A long opening message makes the saving from not resending it obvious.
    const opening = `first question ${'x'.repeat(2000)}`;
    const first = await (await chat([{ role: 'user', content: opening }])).json();
    expect(first.choices[0].message.content).toContain('no tool server');
    const second = await (await chat([
      { role: 'user', content: opening },
      { role: 'assistant', content: first.choices[0].message.content },
      { role: 'user', content: 'second question' },
    ])).json();
    expect(second.choices[0].message.content).toContain('no tool server');
    expect(first.usage.total_tokens).toBe(120);
    expect(second.usage).toEqual(first.usage);
    const third = await (await chat([
      { role: 'user', content: opening },
      first.choices[0].message,
      { role: 'user', content: 'second question' },
      second.choices[0].message,
      { role: 'user', content: 'skip usage' },
    ])).json();
    expect(third.usage).toBeUndefined();

    const recorded = turns(log);
    expect(recorded).toHaveLength(3);
    expect(recorded[2].thread).toBe(recorded[0].thread);
    // One thread for both turns: the second request continued the first session.
    expect(recorded[1].thread).toBe(recorded[0].thread);
    expect(recorded[0].prompt).toContain('first question');
    // The second prompt carries only what the session had not seen yet.
    expect(recorded[1].prompt).toContain('second question');
    expect(recorded[1].prompt).not.toContain('first question');
    expect(recorded[1].prompt.length).toBeLessThan(recorded[0].prompt.length);
  } finally {
    stop();
  }
}, 30000);

test('two follow-ups to a streamed reply never share a CLI session', async () => {
  const { hooks, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const chat = (messages, stream = false) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'codex-test-model', messages, stream }),
    });
    const opening = { role: 'user', content: 'opening prompt' };
    const response = await chat([opening], true);
    const content = (await response.text()).split('\n').filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)).choices[0]?.delta.content ?? '').join('');
    expect(content).toBe('before tool; no tool server');
    const history = [opening, { role: 'assistant', content: [{ type: 'text', text: content }] }];
    await Promise.all(['branch A', 'branch B'].map(async (content) => {
      const reply = await chat([...history, { role: 'user', content }]);
      expect((await reply.json()).choices[0].message.content).toContain('no tool server');
    }));
    const [first, ...branches] = turns(log);
    expect(branches).toHaveLength(2);
    expect(branches.filter(({ thread }) => thread === first.thread)).toHaveLength(1);
    expect(branches.filter(({ prompt }) => prompt.includes('opening prompt'))).toHaveLength(1);
  } finally {
    stop();
  }
}, 30000);

test('a tool result whose call expired replays the transcript instead', async () => {
  const { hooks, bridge, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const tools = [{ type: 'function', function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }];
    const chat = (messages) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'codex-test-model', messages, tools }),
    });
    const first = await (await chat([{ role: 'user', content: 'look it up' }])).json();
    const call = first.choices[0].message.tool_calls[0];
    expect(first.choices[0].finish_reason).toBe('tool_calls');
    // Something else consumed the call, so the parked turn can no longer resume.
    expect(bridge.answer(call.id, 'consumed elsewhere')).toBe(true);

    const resumed = await (await chat([
      { role: 'user', content: 'look it up' },
      first.choices[0].message,
      { role: 'tool', tool_call_id: call.id, content: 'found 42' },
    ])).json();
    // A replay carries the tool result, so the model answers from it directly.
    expect(resumed.choices[0].message.content).toBe('done after tool');

    const recorded = turns(log);
    expect(recorded).toHaveLength(2);
    // The transcript was replayed into a new session, not continued in silence.
    expect(recorded[1].thread).not.toBe(recorded[0].thread);
    expect(recorded[1].prompt).toContain('look it up');
    expect(recorded[1].prompt).toContain('found 42');
  } finally {
    stop();
  }
}, 30000);

test('changing model mid-conversation keeps the same CLI session', async () => {
  const { hooks, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const chat = (model, messages) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model, messages }),
    });
    const opening = { role: 'user', content: 'first question' };
    const first = await (await chat('codex-model-a', [opening])).json();
    const second = await (await chat('codex-model-b', [
      opening,
      { role: 'assistant', content: first.choices[0].message.content },
      { role: 'user', content: 'second question' },
    ])).json();
    expect(second.choices[0].message.content).toContain('no tool server');

    const [opened, switched] = turns(log);
    // Same thread: the context survived the model change.
    expect(switched.thread).toBe(opened.thread);
    expect(switched.model).toBe('model-b');
    expect(switched.prompt).not.toContain('first question');
  } finally {
    stop();
  }
}, 30000);

test('changing reasoning effort mid-conversation keeps the same session', async () => {
  const { hooks, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const chat = (body) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'codex-test-model', ...body }),
    });
    const opening = { role: 'user', content: 'first question' };
    const first = await (await chat({ messages: [opening] })).json();
    const second = await (await chat({
      messages: [opening, { role: 'assistant', content: first.choices[0].message.content }, { role: 'user', content: 'second question' }],
      reasoning_effort: 'high',
    })).json();
    expect(second.choices[0].message.content).toContain('no tool server');

    const [opened, raised] = turns(log);
    expect(raised.thread).toBe(opened.thread);
    expect(raised.effort).toBe('high');
    expect(opened.effort).toBeUndefined();
  } finally {
    stop();
  }
}, 30000);

test('an edited assistant reply falls back to a fresh session', async () => {
  const { hooks, log, stop } = harness();
  try {
    const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
    const chat = (messages) => loader.fetch(`${loader.baseURL}/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: 'codex-test-model', messages }),
    });
    const first = await (await chat([{ role: 'user', content: 'original question' }])).json();
    expect(first.choices[0].message.content).toContain('no tool server');
    const second = await (await chat([
      { role: 'user', content: 'original question' },
      { role: 'assistant', content: 'edited assistant reply' },
      { role: 'user', content: 'follow up' },
    ])).json();
    expect(second.choices[0].message.content).toContain('no tool server');

    const recorded = turns(log);
    expect(recorded).toHaveLength(2);
    expect(recorded[1].thread).not.toBe(recorded[0].thread);
    expect(recorded[1].prompt).toContain('edited assistant reply');
  } finally {
    stop();
  }
}, 30000);
