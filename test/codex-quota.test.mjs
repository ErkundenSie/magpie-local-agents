import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createCodexUsageReader } from '../lib/codex-quota.mjs';

const fixture = `
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
const root = process.argv[2];
const scenario = JSON.parse(readFileSync(join(root, 'scenario.json'), 'utf8'));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === 'initialize') send({ id, result: { userAgent: 'fixture' } });
  else if (method === 'account/rateLimits/read') {
    appendFileSync(join(root, 'calls'), 'limits\\n');
    if (scenario.error) send({ id, error: { code: -32603, message: scenario.error } });
    else send({ id, result: scenario.result });
  } else send({ id, error: { code: -32601, message: 'unexpected ' + method } });
}
`;

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'magpie-codex-quota-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
  const file = join(root, 'cli.mjs');
  await writeFile(file, fixture);
  await writeFile(join(root, '.local-agents.json'), JSON.stringify({
    executables: { codex: { path: process.execPath, args: [file, root] } },
  }));
  let time = Date.parse('2026-11-22T00:00:00Z');
  return {
    read: createCodexUsageReader(root, { now: () => time }),
    advance(ms) { time += ms; },
    scenario: (value) => writeFile(join(root, 'scenario.json'), JSON.stringify(value)),
    calls: async () => (await readFile(join(root, 'calls'), 'utf8')).trim().split('\n'),
  };
}

const limits = (primary, secondary) => ({
  accountId: 'acct_private',
  rateLimits: { primary, secondary },
});

test('Codex rate limits become display-only windows and omit the account id', async (t) => {
  const { read, scenario, calls } = await setup(t);
  await scenario({ result: limits(
    { usedPercent: 100, windowDurationMins: 300, resetsAt: 1795305600 },
    { usedPercent: 56.5, windowDurationMins: 10080, resetsAt: '2026-11-27T00:00:00Z' },
  ) });
  const [first, second] = await Promise.all([read(), read()]);
  assert.deepEqual(first.windows, [
    { name: '5 hours', pool: 'Codex', aside: true, span: 18_000, used: 100, resetsAt: '2026-11-22T00:00:00.000Z' },
    { name: '7 days', pool: 'Codex', aside: true, span: 604_800, used: 56.5, resetsAt: '2026-11-27T00:00:00.000Z' },
  ]);
  assert.equal(JSON.stringify(first).includes('acct_private'), false);
  assert.deepEqual(second, first);
  assert.deepEqual(await calls(), ['limits']);
});

test('a Codex sign-in failure drops cached quota instead of showing it as current', async (t) => {
  const { read, advance, scenario } = await setup(t);
  await scenario({ result: limits({ usedPercent: 10, windowDurationMins: 300 }, { usedPercent: 0, windowDurationMins: 10080 }) });
  assert.equal((await read()).windows.length, 2);
  advance(30_000);
  await scenario({ error: 'Unauthorized: not signed in. private-token' });
  const refused = await read();
  assert.deepEqual(refused.windows, []);
  assert.match(refused.error, /needs sign-in/);
  assert.doesNotMatch(refused.error, /private-token/);
});
