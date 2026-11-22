import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrokUsageReader, parseCredits } from '../lib/grok-quota.mjs';

const token = 'xai-private-token-value';
const weekly = (percent, end = '2026-11-29T00:00:00+00:00') => ({
  config: {
    currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end },
    ...(percent === undefined ? {} : { creditUsagePercent: percent }),
  },
});

function reader(options = {}) {
  const calls = [];
  let time = Date.parse('2026-11-22T00:00:00Z');
  const usage = createGrokUsageReader(process.cwd(), {
    now: () => time,
    env: {},
    readAuthFile: async () => JSON.stringify({ 'https://auth.x.ai': { key: token } }),
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => weekly(76) };
    },
    ...options,
  });
  return { usage, calls, advance: (ms) => { time += ms; } };
}

test('a Grok weekly reply becomes one display-only window and the token stays in the request', async () => {
  const { usage, calls } = reader();
  const [first, second] = await Promise.all([usage(), usage()]);
  assert.deepEqual(first.windows, [{
    pool: 'Grok', aside: true, name: '7 days', span: 604_800, used: 76,
    resetsAt: '2026-11-29T00:00:00.000Z',
  }]);
  assert.deepEqual(second, first);
  assert.equal(calls.length, 1, 'concurrent reads share one request');
  assert.equal(calls[0].url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers['x-xai-token-auth'], 'xai-grok-cli');
  assert.equal(JSON.stringify(first).includes(token), false);
});

test('the legacy monthly shape is converted, and an unknown percentage is never shown as a number', async () => {
  assert.equal(parseCredits({ config: { monthlyLimit: { val: 1000 }, used: { val: 250 } } }).used, 25);
  // proto3 omits zero scalars: a named period is what makes the omission a real zero.
  assert.equal(parseCredits(weekly(undefined)).used, 0);
  assert.throws(() => parseCredits({ config: {} }), /no measured quota limits/);
  assert.throws(() => parseCredits({ config: { creditUsagePercent: '76' } }), /no measured quota limits/);
});

test('an expired or missing xAI sign-in is reported instead of fetched', async () => {
  let fetched = 0;
  const expired = reader({
    readAuthFile: async () => JSON.stringify({
      'https://auth.x.ai': { key: token, expires_at: '2020-01-01T00:00:00Z' },
    }),
    fetch: async () => { fetched++; throw new Error('must not fetch'); },
  });
  const refused = await expired.usage();
  assert.deepEqual(refused.windows, []);
  assert.match(refused.error, /sign-in/);
  assert.equal(fetched, 0);

  const missing = reader({ readAuthFile: async () => { throw new Error('ENOENT'); } });
  assert.match((await missing.usage()).error, /not signed in/);

  const apiKey = reader({ env: { XAI_API_KEY: 'xai-private-token-value' } });
  assert.match((await apiKey.usage()).error, /API key/);
});

test('a refused token drops the cached window, and the opt-out never reads auth.json', async () => {
  let status = 200;
  let time = Date.parse('2026-11-22T00:00:00Z');
  const usage = createGrokUsageReader(process.cwd(), {
    now: () => time,
    env: {},
    readAuthFile: async () => JSON.stringify({ 'https://auth.x.ai': { key: token } }),
    fetch: async () => ({ ok: status === 200, status, json: async () => weekly(42) }),
  });
  assert.equal((await usage()).windows[0].used, 42);
  time += 30_000;
  status = 401;
  const refused = await usage();
  assert.deepEqual(refused.windows, [], 'a refused sign-in must not keep showing the old window');
  assert.match(refused.error, /needs sign-in/);
  assert.doesNotMatch(refused.error, new RegExp(token));

  let reads = 0;
  const off = createGrokUsageReader(process.cwd(), {
    disabled: true,
    readAuthFile: async () => { reads++; return '{}'; },
  });
  assert.deepEqual(await off(), { windows: [] });
  assert.equal(reads, 0);
});
