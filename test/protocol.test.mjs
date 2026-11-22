import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { AgentSession } from '../lib/session.mjs';

function fixture(agent, emit) {
  return new AgentSession(agent, {
    file: process.execPath,
    args: [fileURLToPath(new URL('fixture.mjs', import.meta.url)), agent],
    cwd: process.cwd(), env: process.env,
  }, emit);
}

test('ACP keeps session context and submits only an explicit one-shot decision', async () => {
  const events = [];
  const session = fixture('gemini', (event) => {
    events.push(event);
    if (event.type === 'permission') {
      session.decide(event.id, 'always');
      session.decide(event.id, 'yes');
    }
  });
  try {
    await session.start();
    expect(await session.prompt('first')).toBe('end_turn');
    expect(await session.prompt('second')).toBe('end_turn');
    expect(events.filter(({ type }) => type === 'permission').map(({ options }) => options.map(({ id }) => id)))
      .toEqual([['yes', 'no'], ['yes', 'no']]);
    expect(events.filter(({ type }) => type === 'text').map(({ text }) => text)).toEqual(['回合 1: yes', '回合 2: yes']);
    expect(events.filter(({ type }) => type === 'session')).toHaveLength(1);
    expect(events.filter(({ type }) => type === 'usage').map(({ usage }) => usage)).toEqual([{
      prompt_tokens: 30, completion_tokens: 10, total_tokens: 40,
      prompt_tokens_details: { cached_tokens: 12 },
      completion_tokens_details: { reasoning_tokens: 6 },
    }]);
  } finally {
    session.close();
  }
});

test.each([['grok', 3], ['antigravity', undefined]])('%s reports completed turn usage with cache details', async (agent, cacheWrite) => {
  const events = [];
  const session = fixture(agent, (event) => {
    events.push(event);
    if (event.type === 'permission') session.decide(event.id, 'yes');
  });
  try {
    await session.start();
    await session.prompt('first');
    await session.prompt('second');
    expect(events.filter(({ type }) => type === 'usage').map(({ usage }) => usage)).toEqual([{
      prompt_tokens: 30, completion_tokens: 10, total_tokens: 40,
      prompt_tokens_details: { cached_tokens: 12, ...(cacheWrite !== undefined && { cache_write_tokens: cacheWrite }) },
      completion_tokens_details: { reasoning_tokens: 6 },
    }]);
  } finally {
    session.close();
  }
});

test('ACP cancellation reaches the subprocess and settles the pending request', async () => {
  const session = fixture('gemini', () => {});
  try {
    await session.start();
    const turn = session.prompt('wait');
    session.cancel();
    await expect(turn).rejects.toThrow(/exited/);
  } finally {
    session.close();
  }
});

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const image = { mimeType: 'image/png', data: png };

test('ACP sends images as base64 content blocks next to the text', async () => {
  const events = [];
  const session = fixture('gemini', (event) => events.push(event));
  try {
    await session.start();
    expect(await session.prompt('probe', [image])).toBe('end_turn');
    expect(events.filter(({ type }) => type === 'text').map(({ text }) => text)).toEqual(['text,image:image/png:iVBO']);
  } finally {
    session.close();
  }
});

test('Codex sends images as inline data URLs', async () => {
  const events = [];
  const session = fixture('codex', (event) => events.push(event));
  try {
    await session.start();
    expect(await session.prompt('probe', [image])).toBe('completed');
    expect(events.find((event) => event.type === 'text')?.text)
      .toBe(`text,image:data:image/png;base64,`);
  } finally {
    session.close();
  }
});

test('an ACP agent without the image capability refuses images', async () => {
  const session = new AgentSession('gemini', {
    file: process.execPath,
    args: [fileURLToPath(new URL('fixture.mjs', import.meta.url)), 'gemini', 'no-image'],
    cwd: process.cwd(), env: process.env,
  }, () => {});
  try {
    await session.start();
    await expect(session.prompt('probe', [image])).rejects.toThrow(/image input/);
  } finally {
    session.close();
  }
});

test('a running ACP session switches model without starting over', async () => {
  const events = [];
  const session = fixture('gemini', (event) => events.push(event));
  try {
    await session.start();
    await session.setModel('model-b');
    expect(await session.prompt('probe')).toBe('end_turn');
    expect(events.filter(({ type }) => type === 'text').map(({ text }) => text)).toEqual(['text model:model-b']);
    // The session itself never restarted.
    expect(events.filter(({ type }) => type === 'session')).toHaveLength(1);
  } finally {
    session.close();
  }
});

test('Codex carries the switched model on the next turn', async () => {
  const events = [];
  const session = fixture('codex', (event) => events.push(event));
  try {
    await session.start();
    await session.setModel('gpt-other');
    await session.prompt('probe');
    expect(events.find(({ type }) => type === 'text')?.text).toBe('text model:gpt-other');
    // The model rides on turn/start rather than restarting the thread.
    expect(session.nativeTurn).toBeUndefined();
  } finally {
    session.close();
  }
});

test('a running ACP session applies a reasoning level in place', async () => {
  const events = [];
  const session = fixture('gemini', (event) => events.push(event));
  try {
    await session.start();
    await session.setEffort('high');
    expect(await session.prompt('probe')).toBe('end_turn');
    expect(events.filter(({ type }) => type === 'text').map(({ text }) => text)).toEqual(['text effort:high']);
  } finally {
    session.close();
  }
});

test('Codex carries the reasoning level on the next turn', async () => {
  const events = [];
  const session = fixture('codex', (event) => events.push(event));
  try {
    await session.start();
    await session.setEffort('low');
    await session.prompt('probe');
    expect(events.find(({ type }) => type === 'text')?.text).toBe('text effort:low');
  } finally {
    session.close();
  }
});

test('a CLI that does not offer the level keeps its own default', async () => {
  const events = [];
  const session = fixture('gemini', (event) => events.push(event));
  try {
    await session.start();
    // "minimal" is not among the values this CLI lists.
    await session.setEffort('minimal');
    await session.prompt('probe');
    expect(events.filter(({ type }) => type === 'text').map(({ text }) => text)).toEqual(['text']);
  } finally {
    session.close();
  }
});

test('Codex accepts a completion notification before the turn/start response', async () => {
  const events = [];
  const session = fixture('codex', (event) => events.push(event));
  try {
    await session.start();
    expect(await session.prompt('one')).toBe('completed');
    expect(events.find((event) => event.type === 'text')?.text).toBe('回合 1');
    expect(await session.prompt('two')).toBe('completed');
  } finally {
    session.close();
  }
});
