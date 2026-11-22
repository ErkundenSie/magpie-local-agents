import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAgyUsageReader } from '../lib/agy-quota.mjs';

const fixture = `
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const [root, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
assert.notEqual(process.cwd(), root);
assert.equal(process.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
assert.equal(existsSync(process.env.BROWSER), true);
assert.equal(process.env.CLOUD_CODE_URL, undefined);
if (args[0] === '--version') {
  appendFileSync(join(root, 'calls'), 'version\\n');
  console.log(scenario.version ?? '1.5.14');
} else {
  appendFileSync(join(root, 'calls'), 'usage\\n');
  const [settings, flags, prompt, format, json, agentFlag, agent, timeoutFlag, timeout] = args.slice(1);
  assert.equal(args[0], '--settings');
  assert.equal(JSON.parse(settings).toolPermission, 'strict');
  assert.deepEqual([flags, prompt, format, json, agentFlag, timeoutFlag], ['-p', '/usage', '--output-format', 'json', '--agent', '--print-timeout']);
  assert.match(timeout, /^\\d+s$/);
  assert.equal(existsSync(join('.agents', 'agents', agent, 'agent.md')), true);
  if (scenario.stderr) console.error(scenario.stderr);
  if (scenario.report !== undefined) {
    console.log(typeof scenario.report === 'string' ? scenario.report : JSON.stringify(scenario.report));
  }
  process.exitCode = scenario.code ?? 0;
}
`;

const quota = (buckets) => ({
  status: 'SUCCESS',
  command: { name: 'usage', data: { groups: [{ display_name: 'Gemini models', buckets }] } },
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'magpie-quota-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const file = join(root, 'cli.mjs');
  await writeFile(file, fixture);
  await writeFile(join(root, '.local-agents.json'), JSON.stringify({
    executables: { antigravity: { path: process.execPath, args: [file, root] } },
  }));
  let time = Date.parse('2026-11-22T00:00:00Z');
  return {
    read: createAgyUsageReader(root, { now: () => time }),
    advance(ms) { time += ms; },
    scenario: (value) => writeFile(join(root, 'scenario.json'), JSON.stringify(value)),
    calls: async () => (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n'),
  };
}

test('native usage reports display-only usage windows and deduplicates concurrent reads', async (t) => {
  const { read, scenario, calls } = await setup(t);
  await scenario({ report: quota([
    { bucket_id: 'five_hour', remaining_fraction: 0, reset_time: 1795305600 },
    { bucketId: 'weekly', remaining: { case: 'remainingFraction', value: 0.975 }, resetTime: '2026-11-27T03:00:00+03:00' },
    { id: 'short', window: '3h', displayName: '3 hours', remaining: { remainingFraction: 1 } },
    { id: 'unknown', remainingFraction: '0', resetTime: '2026-11-27T00:00:00' },
    { id: 'disabled', disabled: true, remainingFraction: 0 },
    null,
  ]) });
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual(first, {
    readAt: '2026-11-22T00:00:00.000Z',
    windows: [
      { name: '5 hours', pool: 'Gemini (agy)', aside: true, span: 18_000, used: 100, resetsAt: '2026-11-22T00:00:00.000Z' },
      { name: '7 days', pool: 'Gemini (agy)', aside: true, span: 604_800, used: 2.5, resetsAt: '2026-11-27T00:00:00.000Z' },
      { name: '3 hours', pool: 'Gemini (agy)', aside: true, used: 0 },
      { name: 'unknown', pool: 'Gemini (agy)', aside: true, display: 'Limits not available' },
    ],
  });
  assert.deepEqual(second, first);
  first.windows[0].used = 0;
  assert.equal((await read()).windows[0].used, 100);
  assert.deepEqual(await calls(), ['version', 'usage']);
});

test('refresh retains the real read time on temporary failure, expires stale data and recovers', async (t) => {
  const { read, advance, scenario, calls } = await setup(t);
  await scenario({ report: quota([{ id: '5h', remainingFraction: 0.5 }]) });
  const first = await read();
  advance(30_000);
  await scenario({ code: 1, stderr: 'Eligibility check failed: EOF private-url-marker' });
  const stale = await read();
  assert.deepEqual(stale.windows, first.windows);
  assert.equal(stale.readAt, first.readAt);
  assert.match(stale.error, /over the network/);
  assert.doesNotMatch(stale.error, /private-url-marker/);
  assert.deepEqual(await read(), stale);
  assert.deepEqual(await calls(), ['version', 'usage', 'version', 'usage']);

  advance(15 * 60_000);
  assert.deepEqual(await read(), { windows: [], error: stale.error });
  advance(30_000);
  await scenario({ report: quota([{ id: '5h', remainingFraction: 0.75 }]) });
  const recovered = await read();
  assert.equal(recovered.error, undefined);
  assert.notEqual(recovered.readAt, first.readAt);
  assert.equal(recovered.windows[0].used, 25);
});

test('an unverified CLI version skips /usage and explicit sign-in errors discard stale quota', async (t) => {
  const { read, advance, scenario, calls } = await setup(t);
  await scenario({ version: '1.1.10' });
  assert.match((await read()).error, /1\.1\.11 or later/);
  advance(30_000);
  await scenario({ version: '1.5.14-dev' });
  assert.match((await read()).error, /verified agy version/);
  assert.deepEqual(await calls(), ['version', 'version']);
  advance(30_000);
  await scenario({ version: '1.1.11', report: quota([{ id: '5h', remainingFraction: 0.5 }]) });
  assert.equal((await read()).windows.length, 1);
  advance(30_000);
  await scenario({ report: { status: 'ERROR', error: 'Please sign in: private-url-marker' } });
  const refused = await read();
  assert.deepEqual(refused.windows, []);
  assert.equal(refused.readAt, undefined);
  assert.match(refused.error, /needs sign-in/);
  assert.doesNotMatch(refused.error, /private-url-marker/);
  advance(30_000);
  await scenario({ report: quota([{ id: '5h', remainingFraction: 0.5 }]) });
  assert.equal((await read()).windows.length, 1);
  advance(30_000);
  await scenario({ code: 1, stderr: 'Antigravity is not currently available in your location: private-location-marker' });
  const ineligible = await read();
  assert.deepEqual(ineligible.windows, []);
  assert.equal(ineligible.readAt, undefined);
  assert.match(ineligible.error, /cannot access its quota/);
  assert.doesNotMatch(ineligible.error, /private-location-marker/);
});

test('Antigravity group names say whose quota they are', async (t) => {
  const { read, scenario } = await setup(t);
  await scenario({ report: {
    status: 'SUCCESS',
    command: { name: 'usage', data: { groups: [
      { display_name: 'Gemini Models', buckets: [{ id: 'weekly', window: '7d', remainingFraction: 0.939 }] },
      { display_name: 'Claude and GPT models', buckets: [{ id: 'weekly', window: '7d', remainingFraction: 1 }] },
      { displayName: 'Other', buckets: [{ id: 'weekly', remainingFraction: 0.5 }] },
    ] } },
  } });
  assert.deepEqual((await read()).windows.map(({ pool, name, used }) => ({ pool, name, used })), [
    { pool: 'Gemini (agy)', name: '7 days', used: 6.1 },
    { pool: 'Claude/GPT (agy)', name: '7 days', used: 0 },
    { pool: 'Other (agy)', name: '7 days', used: 50 },
  ]);
});

test('malformed and unmeasured native reports never imply an allowance', async (t) => {
  const { read, advance, scenario } = await setup(t);
  for (const [report, error] of [
    ['private-raw-output', /invalid quota report/],
    [{ status: 'SUCCESS', command: { name: 'models', data: { groups: [] } } }, /unrecognized quota report/],
    [quota([{ id: 'weekly', remainingFraction: 1.1 }, { id: '5h', remainingFraction: null }]), /no measured quota limits/],
  ]) {
    await scenario({ report });
    const result = await read();
    assert.deepEqual(result.windows, []);
    assert.equal(result.readAt, undefined);
    assert.match(result.error, error);
    assert.doesNotMatch(result.error, /private-raw-output/);
    advance(30_000);
  }
});
