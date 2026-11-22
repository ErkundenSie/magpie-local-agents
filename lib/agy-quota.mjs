import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { launchAgent } from './launch.mjs';

const readTimeoutMs = 15_000;
const freshMs = 30_000;
const retryMs = 30_000;
const staleMs = 15 * 60_000;
const maxOutputBytes = 1024 * 1024;
const windows = process.platform === 'win32';

class QuotaError extends Error {
  constructor(message, canUseStale = true) {
    super(message);
    this.canUseStale = canUseStale;
  }
}

function supportedVersion(output) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(output.trim());
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) &&
    (major > 1 || major === 1 && (minor > 1 || minor === 1 && patch >= 11));
}

function commandError(output) {
  // Startup diagnostics can mention unauthenticated lookups before agy loads its sign-in.
  const message = output.split(/\r?\n/).filter((line) => !/^\s*[IWEF]\d{4}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+[^\]]+\]/.test(line)).join('\n');
  const eligibilityError = 'Antigravity CLI reports that the account cannot access its quota. Check agy in a terminal.';
  if (/not (?:currently )?available in your (?:region|country|location)|not eligible|unsupported[ _](?:region|country|location)|permission.denied|valid license|verification required/i.test(message)) {
    return new QuotaError(eligibilityError, false);
  }
  if (/not (?:logged|signed) in|unauthenticated|(?:authentication|login) required|please (?:log|sign) in|invalid_grant/i.test(message)) {
    return new QuotaError('Antigravity CLI needs sign-in. Run agy in a terminal to sign in.', false);
  }
  if (/\b(?:eof|timed? ?out|timeout|deadline exceeded|no such host|connection (?:refused|reset)|network|proxy|tls|certificate)\b/i.test(message)) {
    return new QuotaError('Antigravity CLI could not check quota over the network.');
  }
  if (/eligibility check failed/i.test(message)) return new QuotaError(eligibilityError, false);
  return new QuotaError('Antigravity CLI could not read quota. Check agy in a terminal.');
}

const text = (value) => typeof value === 'string' ? value.trim() : '';

function resetTime(value) {
  const raw = typeof value === 'number' ? String(value) : text(value);
  let ms;
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const number = Number(raw);
    ms = number < 1e11 ? number * 1000 : number;
  } else if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) {
    ms = Date.parse(raw);
  }
  if (Number.isFinite(ms) && ms > 0 && ms < 253402300800000) return new Date(ms).toISOString();
}

// The CLI names one group "Claude and GPT models". On the quota card that
// reads as Claude's or GPT's own plan, so the pool is the model name plus (agy).
function agyPool(label) {
  const raw = label || 'Antigravity';
  const name = /gemini/i.test(raw) && !/claude|gpt/i.test(raw) ? 'Gemini'
    : /claude/i.test(raw) && /gpt/i.test(raw) ? 'Claude/GPT'
      : raw.replace(/\s+models?$/i, '');
  return /\(agy\)$/i.test(name) ? name : `${name} (agy)`;
}

function bucketPeriod(window, id, label) {
  const explicit = text(window);
  const cadence = `${id} ${label}`;
  const fiveHours = explicit ? /^(?:5h|five[ _-]?hours?|session)$/i.test(explicit) :
    /(?:^|[\s_-])(?:5h|five[ _-]?hours?|session)(?:$|[\s_-])/i.test(cadence);
  const week = explicit ? /^(?:7d|weeks?|weekly|seven[ _-]?days?)$/i.test(explicit) :
    /(?:^|[\s_-])(?:7d|weeks?|weekly|seven[ _-]?days?)(?:$|[\s_-])/i.test(cadence);
  if (fiveHours) return { name: '5 hours', span: 18_000 };
  if (week) return { name: '7 days', span: 604_800 };
  return { name: label || id };
}

function parseReport(stdout) {
  let report;
  try { report = JSON.parse(stdout); }
  catch { throw new QuotaError('Antigravity CLI returned an invalid quota report.'); }
  if (report?.status !== 'SUCCESS') throw commandError(`${text(report?.error)}\n${text(report?.response)}`);
  if (report.command?.name !== 'usage' || !Array.isArray(report.command.data?.groups)) {
    throw new QuotaError('Antigravity CLI returned an unrecognized quota report.');
  }
  const result = [];
  for (const group of report.command.data.groups) {
    if (!Array.isArray(group?.buckets)) continue;
    const pool = agyPool(text(group.displayName ?? group.display_name) || text(group.name));
    for (const bucket of group.buckets) {
      const id = text(bucket?.bucketId ?? bucket?.bucket_id) || text(bucket?.id);
      if (!id || bucket.disabled === true) continue;
      const label = text(bucket.displayName ?? bucket.display_name) || text(bucket.name);
      const remaining = bucket.remaining;
      const fraction = bucket.remainingFraction ?? bucket.remaining_fraction ??
        remaining?.remainingFraction ?? remaining?.remaining_fraction ??
        (remaining?.case === 'remainingFraction' ? remaining.value : undefined);
      const known = typeof fraction === 'number' && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1;
      const resetsAt = resetTime(bucket.resetTime ?? bucket.reset_time);
      result.push({
        ...bucketPeriod(bucket.window, id, label),
        pool,
        aside: true,
        ...(known ? { used: Math.round((1 - fraction) * 1e8) / 1e6 } : { display: 'Limits not available' }),
        ...(resetsAt && { resetsAt }),
      });
    }
  }
  if (!result.some(({ used }) => used !== undefined)) throw new QuotaError('Antigravity CLI returned no measured quota limits.');
  return result;
}

function runCLI(launch, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = execFile(launch.file, args, {
      cwd: launch.cwd, env: launch.env, windowsHide: true, maxBuffer: maxOutputBytes, timeout,
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      if (error?.killed) return reject(new QuotaError('Antigravity CLI quota check timed out.'));
      if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new QuotaError('Antigravity CLI quota output exceeded the size limit.'));
      if (error && typeof error.code !== 'number') return reject(new QuotaError('Could not start the Antigravity CLI quota check.'));
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end();
  });
}

async function readNativeQuota(root) {
  const directory = await mkdtemp(join(tmpdir(), 'magpie-agy-quota-'));
  try {
    let launch;
    try { launch = launchAgent(root, 'antigravity', directory); }
    catch { throw new QuotaError('Antigravity CLI is unavailable or its settings do not allow native access. Check agy in a terminal.', false); }
    // launchAgent provides the executable and optional wrapper arguments before `acp`.
    const prefix = launch.args.slice(0, -1);
    const browser = join(directory, windows ? 'open.cmd' : 'open');
    const stub = windows ? '@exit /b 1\r\n' : '#!/bin/sh\nexit 1\n';
    await writeFile(browser, stub, { mode: 0o700 });
    if (!windows) await writeFile(join(directory, 'xdg-open'), stub, { mode: 0o700 });
    const path = launch.env.PATH ?? launch.env.Path ?? '';
    for (const key of Object.keys(launch.env)) {
      if (/^(?:PATH|BROWSER|CLOUD_CODE_URL|AGY_CLI_DISABLE_AUTO_UPDATE)$/i.test(key)) delete launch.env[key];
    }
    // Use the CLI's own sign-in and default Code Assist URL. Browser shims are best-effort.
    launch.env.PATH = [directory, path].filter(Boolean).join(delimiter);
    launch.env.BROWSER = browser;
    launch.env.AGY_CLI_DISABLE_AUTO_UPDATE = 'true';

    const agent = 'magpie-quota';
    const agentDir = join(directory, '.agents', 'agents', agent);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'agent.md'), [
      '---', `name: ${agent}`, 'description: Read native CLI quota', 'mainAgent: true',
      'subagent: false', 'tools: []', 'mcpServers: []', '---', 'Do not run model prompts or tools.', '',
    ].join('\n'));
    const settings = JSON.stringify({
      toolPermission: 'strict', permissions: { deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'] },
    });
    const deadline = Date.now() + readTimeoutMs;
    const version = await runCLI(launch, [...prefix, '--version'], 3_000);
    if (version.code !== 0 || !supportedVersion(version.stdout)) {
      throw new QuotaError('Native Antigravity quota requires a verified agy version 1.1.11 or later. Update agy and try again.', false);
    }
    const remaining = Math.max(1, deadline - Date.now());
    const result = await runCLI(launch, [...prefix, '--settings', settings, '-p', '/usage', '--output-format', 'json',
      '--agent', agent, '--print-timeout', `${Math.ceil(remaining / 1000)}s`], remaining);
    if (result.code !== 0) throw commandError(`${result.stderr}\n${result.stdout}`);
    return parseReport(result.stdout);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}

export function createAgyUsageReader(root, { now = Date.now } = {}) {
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
        failure = { at: now(), message: error instanceof QuotaError ? error.message : 'Could not check quota with the Antigravity CLI.' };
      }).finally(() => { pending = undefined; });
    }
    await pending;
    return result();
  };
}
