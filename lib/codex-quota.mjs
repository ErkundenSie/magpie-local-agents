import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAgent } from './launch.mjs';
import { Rpc } from './rpc.mjs';

const freshMs = 30_000;
const retryMs = 30_000;
const staleMs = 15 * 60_000;

class QuotaError extends Error {
  constructor(message, canUseStale = true) {
    super(message);
    this.canUseStale = canUseStale;
  }
}

function resetTime(value) {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw);
    ms = number < 1e11 ? number * 1000 : number;
  } else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    ms = Date.parse(raw);
  }
  if (Number.isFinite(ms) && ms > 0 && ms < 253402300800000) return new Date(ms).toISOString();
}

function quotaWindow(bucket, minutes, name) {
  const used = bucket?.usedPercent;
  const known = typeof used === 'number' && Number.isFinite(used) && used >= 0 && used <= 100;
  const duration = bucket?.windowDurationMins ?? minutes;
  const resetsAt = resetTime(bucket?.resetsAt);
  return {
    name: duration === 300 ? '5 hours' : duration === 10080 ? '7 days' : name,
    pool: 'Codex',
    aside: true,
    ...(Number.isFinite(duration) && duration > 0 && { span: duration * 60 }),
    ...(known ? { used: Math.round(used * 1e6) / 1e6 } : { display: 'Limits not available' }),
    ...(resetsAt && { resetsAt }),
  };
}

function parseLimits(result) {
  const limits = result?.rateLimits;
  if (!limits || typeof limits !== 'object') throw new QuotaError('Codex returned an unrecognized quota report.');
  const windows = [
    limits.primary && quotaWindow(limits.primary, 300, 'primary'),
    limits.secondary && quotaWindow(limits.secondary, 10080, 'secondary'),
  ].filter(Boolean);
  if (!windows.some((window) => window.used !== undefined)) {
    throw new QuotaError('Codex returned no measured quota limits.');
  }
  return windows;
}

function classify(message) {
  if (/not (?:logged|signed) in|unauthorized|unauthenticated|login required|invalid_grant|\b401\b/i.test(message)) {
    return new QuotaError('Codex needs sign-in. Sign in from the Codex CLI or desktop app.', false);
  }
  if (/method not found|-32601/i.test(message)) {
    return new QuotaError('This Codex version does not report subscription quota.', false);
  }
  if (/\b(?:timed? ?out|timeout|network|connection|proxy)\b/i.test(message)) {
    return new QuotaError('Codex could not check quota over the network.');
  }
  return new QuotaError('Codex could not read quota. Check the Codex CLI and try again.');
}

async function readNativeQuota(root) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-codex-quota-'));
  let rpc;
  try {
    let launch;
    try { launch = launchAgent(root, 'codex', directory); }
    catch { throw new QuotaError('Codex is unavailable or its settings do not allow native access.', false); }
    rpc = new Rpc(launch);
    await rpc.request('initialize', {
      clientInfo: { name: 'magpie-local-agents', title: 'Magpie Local CLI', version: '0.10.0' },
    }, 8000);
    rpc.notify('initialized');
    const result = await rpc.request('account/rateLimits/read', {}, 8000);
    return parseLimits(result);
  } catch (error) {
    if (error instanceof QuotaError) throw error;
    throw classify(String(error?.message ?? ''));
  } finally {
    rpc?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}

export function createCodexUsageReader(root, { now = Date.now } = {}) {
  let pending;
  let latest;
  let failure;
  const result = () => {
    const available = latest && now() - latest.at < staleMs;
    return {
      windows: available ? latest.windows.map((window) => ({ ...window })) : [],
      ...(available && { readAt: new Date(latest.at).toISOString() }),
      ...(failure && { error: failure.message }),
    };
  };
  return async function readUsage() {
    if (!pending && (failure ? now() - failure.at >= retryMs : !latest || now() - latest.at >= freshMs)) {
      pending = readNativeQuota(root).then((windows) => {
        latest = { at: now(), windows };
        failure = undefined;
      }, (error) => {
        if (error instanceof QuotaError && !error.canUseStale) latest = undefined;
        failure = { at: now(), message: error instanceof QuotaError ? error.message : 'Could not check quota with Codex.' };
      }).finally(() => { pending = undefined; });
    }
    await pending;
    return result();
  };
}
