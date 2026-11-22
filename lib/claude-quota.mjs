// Claude reports plan limits over ACP, not through a credential file:
// `usage_update` notifications and prompt results carry `_meta["_claude/rateLimit"]`
// with each window's utilization. This module turns those reports into the
// display-only windows Magpie shows, and remembers the last one it saw.
const staleMs = 15 * 60_000;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function percent(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

function resetTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string' && value) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  }
  return undefined;
}

// A window's name decides what the card says; the vendor's own keys are the
// only reliable signal, so an unknown one keeps its key rather than guessing.
function windowOf(type) {
  const key = String(type ?? '').toLowerCase();
  const span = /five|5h|session|hour/.test(key) ? { name: '5 hours', span: 18_000 }
    : /week|7d|seven/.test(key) ? { name: '7 days', span: 604_800 }
      : undefined;
  if (!span) return { name: String(type ?? 'window') };
  const scope = /opus/.test(key) ? ' · Opus' : /sonnet/.test(key) ? ' · Sonnet' : /oauth/.test(key) ? ' · OAuth apps' : '';
  return { ...span, name: `${span.name}${scope}` };
}

function bucket(type, value) {
  if (!isRecord(value)) return undefined;
  const used = percent(value.utilization ?? value.used_percent ?? value.usedPercent);
  if (used === undefined) return undefined;
  const resetsAt = resetTime(value.resetsAt ?? value.resets_at ?? value.resetsAtUnix);
  return {
    pool: 'Claude',
    aside: true,
    ...windowOf(type ?? value.type ?? value.window),
    used: Math.round(used * 1e6) / 1e6,
    ...(resetsAt && { resetsAt }),
  };
}

// Accepts the shapes seen in the wild: buckets keyed by window name, the
// unified-window list, or a single bucket with its type named.
export function parseRateLimit(limit) {
  if (!isRecord(limit)) return [];
  const info = isRecord(limit.rate_limit_info) ? limit.rate_limit_info
    : isRecord(limit.rateLimitInfo) ? limit.rateLimitInfo : limit;
  const windows = [];
  const list = Array.isArray(info.unifiedWindows) ? info.unifiedWindows
    : Array.isArray(info.unified_windows) ? info.unified_windows : undefined;
  if (list) {
    for (const entry of list) {
      const parsed = bucket(entry?.type ?? entry?.window ?? entry?.rateLimitType, entry);
      if (parsed) windows.push(parsed);
    }
  }
  for (const [key, value] of Object.entries(info)) {
    if (key === 'unifiedWindows' || key === 'unified_windows' || key === 'status' || key === 'type') continue;
    const parsed = bucket(key, value);
    if (parsed) windows.push(parsed);
  }
  if (!windows.length) {
    const single = bucket(info.type ?? info.rateLimitType, info);
    if (single) windows.push(single);
  }
  // One row per window name keeps the card readable when a reply repeats keys.
  const unique = new Map();
  for (const window of windows) unique.set(`${window.name}\u0000${window.pool}`, window);
  return [...unique.values()];
}

export function createClaudeQuota({ now = Date.now } = {}) {
  let latest;
  return {
    // Called with whatever the adapter reported; unparsable reports change nothing.
    observe(limit) {
      const windows = parseRateLimit(limit);
      if (windows.length) latest = { at: now(), windows };
      return windows;
    },
    read() {
      const fresh = latest && now() - latest.at < staleMs;
      return {
        windows: fresh ? latest.windows.map((window) => ({ ...window })) : [],
        ...(fresh && { readAt: new Date(latest.at).toISOString() }),
      };
    },
  };
}
