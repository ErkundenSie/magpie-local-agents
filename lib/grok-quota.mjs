import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const freshMs = 30_000;
const retryMs = 30_000;
const staleMs = 15 * 60_000;
const requestMs = 15_000;
const billing = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';

class QuotaError extends Error {
  constructor(message, canUseStale = true) {
    super(message);
    this.canUseStale = canUseStale;
  }
}

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

function grokHome(env) {
  return env.GROK_HOME || join(env.HOME || env.USERPROFILE || homedir(), '.grok');
}

// The CLI stores one entry per issuer; only xAI's own sign-in is a subscription.
function selectToken(auth, now) {
  if (!isRecord(auth)) return undefined;
  for (const [issuer, value] of Object.entries(auth)) {
    if (!issuer.startsWith('https://auth.x.ai')) continue;
    if (!isRecord(value) || typeof value.key !== 'string' || !value.key) continue;
    if (typeof value.expires_at === 'string') {
      const expires = Date.parse(value.expires_at);
      if (Number.isFinite(expires) && expires <= now) continue;
    }
    return value.key;
  }
  return undefined;
}

function finitePercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined;
}

// A Cent wrapper can omit `val` for zero amounts.
function centValue(value) {
  if (!isRecord(value)) return undefined;
  const amount = value.val === undefined ? 0 : value.val;
  return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : undefined;
}

function resetTime(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0 || ms > 253402300800000) return undefined;
  return new Date(ms).toISOString();
}

function periodName(type) {
  const normal = String(type ?? '').toUpperCase();
  if (normal.includes('WEEKLY')) return { name: '7 days', span: 604_800 };
  if (normal.includes('MONTHLY')) return { name: '30 days', span: 2_592_000 };
  return undefined;
}

// The reply shape is a proto3 JSON message, so a zero scalar is omitted. An
// omitted percentage only reads as zero when the reply names a real period;
// otherwise the answer is unknown and the caller must not invent a number.
export function parseCredits(payload) {
  const config = isRecord(payload) && isRecord(payload.config) ? payload.config : undefined;
  if (!config) throw new QuotaError('Grok returned an unrecognized quota report.');
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const window = periodName(period?.type);
  const resetsAt = resetTime(period?.end) ?? resetTime(config.billingPeriodEnd);
  let used = finitePercent(config.creditUsagePercent);
  if (used === undefined) {
    const limit = centValue(config.monthlyLimit);
    if (limit !== undefined && limit > 0) {
      used = Math.min(100, ((centValue(config.used) ?? 0) / limit) * 100);
    } else if (window && resetsAt) {
      used = 0;
    }
  }
  if (used === undefined) throw new QuotaError('Grok returned no measured quota limits.');
  return {
    pool: 'Grok',
    aside: true,
    name: window?.name ?? 'Weekly',
    ...(window && { span: window.span }),
    used: Math.round(used * 1e6) / 1e6,
    ...(resetsAt && { resetsAt }),
  };
}

function classify(status) {
  if (status === 401 || status === 403) {
    return new QuotaError('Grok needs sign-in. Run grok login in a terminal.', false);
  }
  if (status === 429) return new QuotaError('Grok is rate limiting the quota check. Try again later.');
  return new QuotaError('Grok could not report quota. Check grok login and the network.');
}

async function readNativeQuota({ env, fetchImpl, readAuthFile, now }) {
  // An API-configured environment is not the OAuth account whose plan is shown.
  if ([env.XAI_API_KEY, env.GROK_API_KEY, env.GROK_TOKEN].some((value) => value?.trim())) {
    throw new QuotaError('Grok is configured through an API key, so there is no subscription window to show.', false);
  }
  let auth;
  try { auth = JSON.parse(await readAuthFile(join(grokHome(env), 'auth.json'))); }
  catch { throw new QuotaError('Grok is not signed in on this machine. Run grok login in a terminal.', false); }
  const token = selectToken(auth, now());
  if (!token) throw new QuotaError('Grok has no usable sign-in. Run grok login in a terminal.', false);
  let response;
  try {
    response = await fetchImpl(billing, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'x-xai-token-auth': 'xai-grok-cli',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(requestMs),
    });
  } catch {
    throw new QuotaError('Grok could not check quota over the network.');
  }
  if (!response.ok) throw classify(response.status);
  let payload;
  try { payload = await response.json(); }
  catch { throw new QuotaError('Grok returned an unreadable quota report.'); }
  return [parseCredits(payload)];
}

export function createGrokUsageReader(root, {
  now = Date.now, env = process.env, fetch: fetchImpl = globalThis.fetch,
  readAuthFile = (file) => readFile(file, 'utf8'),
  disabled = env.MAGPIE_LOCAL_CLI_GROK_QUOTA === '0',
} = {}) {
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
    if (disabled) return { windows: [] };
    if (!pending && (failure ? now() - failure.at >= retryMs : !latest || now() - latest.at >= freshMs)) {
      pending = readNativeQuota({ env, fetchImpl, readAuthFile, now }).then((windows) => {
        latest = { at: now(), windows };
        failure = undefined;
      }, (error) => {
        if (error instanceof QuotaError && !error.canUseStale) latest = undefined;
        failure = { at: now(), message: error instanceof QuotaError ? error.message : 'Could not check quota with Grok.' };
      }).finally(() => { pending = undefined; });
    }
    await pending;
    return result();
  };
}
