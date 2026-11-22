import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClaudeQuota, parseRateLimit } from '../lib/claude-quota.mjs';

test('Claude plan windows are read from every shape the ACP adapter is known to send', () => {
  const keyed = parseRateLimit({
    five_hour: { utilization: 42, resets_at: '2026-11-22T06:00:00Z' },
    seven_day: { utilization: 12.5, resetsAt: '2026-11-27T00:00:00Z' },
    seven_day_opus: { utilization: 3 },
  });
  assert.deepEqual(keyed, [
    { pool: 'Claude', aside: true, name: '5 hours', span: 18_000, used: 42, resetsAt: '2026-11-22T06:00:00.000Z' },
    { pool: 'Claude', aside: true, name: '7 days', span: 604_800, used: 12.5, resetsAt: '2026-11-27T00:00:00.000Z' },
    { pool: 'Claude', aside: true, name: '7 days · Opus', span: 604_800, used: 3 },
  ]);

  const unified = parseRateLimit({ rate_limit_info: { unifiedWindows: [
    { type: 'five_hour', utilization: 10, resetsAt: 1795305600 },
  ] } });
  assert.deepEqual(unified, [
    { pool: 'Claude', aside: true, name: '5 hours', span: 18_000, used: 10, resetsAt: '2026-11-22T00:00:00.000Z' },
  ]);

  const nested = parseRateLimit({ rateLimitInfo: { seven_day: { usedPercent: 75 } } });
  assert.equal(nested[0].used, 75);
});

test('an unusable report changes nothing and a stale window stops being shown', () => {
  let time = Date.parse('2026-11-22T00:00:00Z');
  const quota = createClaudeQuota({ now: () => time });
  assert.deepEqual(quota.read(), { windows: [] });
  assert.deepEqual(quota.observe({ five_hour: { utilization: 'n/a' } }), []);
  assert.deepEqual(quota.read(), { windows: [] });

  quota.observe({ five_hour: { utilization: 60, resets_at: '2026-11-22T06:00:00Z' } });
  const fresh = quota.read();
  assert.equal(fresh.windows[0].used, 60);
  assert.equal(fresh.readAt, '2026-11-22T00:00:00.000Z');
  // The reader hands out copies, so a consumer cannot corrupt the cache.
  fresh.windows[0].used = 0;
  assert.equal(quota.read().windows[0].used, 60);

  time += 15 * 60_000;
  assert.deepEqual(quota.read(), { windows: [] });
});
