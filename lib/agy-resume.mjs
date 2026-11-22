import { createHash, randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

const defaultTtl = 6 * 60 * 60 * 1000;
const maxEntries = 64;
const readyName = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/;
const digest = /^[a-f0-9]{64}$/;
const privateUid = process.platform === 'win32' ? undefined : process.getuid?.();
export const hash = (text) => createHash('sha256').update(text).digest('hex');

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function privatePath(path, directory) {
  const info = lstatSync(path);
  if (!(directory ? info.isDirectory() : info.isFile()) ||
      (privateUid !== undefined && (info.uid !== privateUid || info.mode & 0o077))) {
    throw new Error('Unsafe Antigravity recovery path.');
  }
  return info;
}

function remove(path) {
  try { unlinkSync(path); } catch { /* Another host may have taken it. */ }
}

function writeAtomic(path, data) {
  const temporary = join(dirname(path), `.writing-${randomUUID()}`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(data));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    remove(temporary);
  }
}

function validCheckpoint(row) {
  return row?.version === 1 && Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.at) &&
    typeof row.sessionId === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(row.sessionId) &&
    Number.isSafeInteger(row.historyLength) && row.historyLength > 1 &&
    [row.historyHash, row.toolConfig, row.caller, row.launchHash].every((value) => typeof value === 'string' && digest.test(value)) &&
    (row.model === undefined || (typeof row.model === 'string' && /^[A-Za-z0-9._-]{1,96}$/.test(row.model))) &&
    (row.effort === undefined || (typeof row.effort === 'string' && /^(minimal|low|medium|high|xhigh|max)$/.test(row.effort))) &&
    (row.agent === undefined || row.agent === 'antigravity' || row.agent === 'grok');
}

export function callerScope(input, init, body) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const session = headers.get('x-magpie-session') ?? '';
  // Magpie's synthesized ID can change with the request rather than the chat.
  return hash(JSON.stringify([
    /^magpie-[a-f0-9]{24}$/.test(session) ? '' : session,
    headers.get('x-magpie-subagent') ?? '',
    typeof body.user === 'string' ? body.user : '',
  ]));
}

export function launchIdentity({ file, args, cwd, env }, agent) {
  const stable = new Map([[join(cwd, 'gateway-settings.json'), '<gateway-settings>'], [join(cwd, 'gateway-agent.md'), '<gateway-agent>']]);
  const identity = [file, args.map((arg) => stable.get(arg) ?? arg),
    env.HOME, env.USERPROFILE, env.GEMINI_CLI_HOME, env.XDG_CONFIG_HOME];
  if (agent === 'grok') identity.push(env.GROK_HOME);
  return hash(JSON.stringify(identity));
}

export function agyResumeStore(root, { directory, ttlMs } = {}) {
  const base = directory ?? process.env.MAGPIE_LOCAL_CLI_AGY_RESUME_DIR ??
    join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'magpie-local-agents');
  const ttl = Number(ttlMs ?? process.env.MAGPIE_LOCAL_CLI_AGY_RESUME_TTL_MS ?? defaultTtl);
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || !isAbsolute(base)) return undefined;
  let state;
  let lastSweep = 0;

  function stateDirectory() {
    if (state) { privatePath(state, true); return state; }
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const parent = realpathSync(base);
    const profile = process.env.MAGPIE_CONFIG_DIR ?? process.env.XDG_CONFIG_HOME ?? '';
    const path = join(parent, `agy-${hash(JSON.stringify([realpathSync(root), homedir(), profile]))}`);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    privatePath(path, true);
    return (state = path);
  }

  // Each generation has its own file name. Renaming it to a unique name
  // consumes the checkpoint even if its claimant exits before sending a prompt.
  function take({ file }) {
    const claimed = `${file}.taken-${randomUUID()}`;
    try {
      stateDirectory();
      renameSync(file, claimed);
    } catch { return false; }
    remove(claimed);
    remove(`${file}.released`);
    return true;
  }

  function released(file) {
    try { privatePath(`${file}.released`, false); return true; }
    catch { return false; }
  }

  function entries() {
    const home = stateDirectory();
    const now = Date.now();
    const sweep = now - lastSweep >= 60000;
    if (sweep) lastSweep = now;
    const available = [];
    for (const entry of readdirSync(home, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = join(home, entry.name);
      try {
        const info = privatePath(file, false);
        if (!readyName.test(entry.name)) {
          if (sweep && now - info.mtimeMs > ttl && /^(?:\.writing-|[a-f0-9-]+\.json\.taken-)/.test(entry.name)) remove(file);
          continue;
        }
        const row = info.size <= 4096 && JSON.parse(readFileSync(file, 'utf8'));
        if (!validCheckpoint(row) || row.at > now) continue;
        if (!released(file) && processAlive(row.pid)) continue;
        const checkpoint = { ...row, file };
        if (now - row.at > ttl) {
          if (sweep) take(checkpoint);
        } else {
          available.push(checkpoint);
        }
      } catch { /* A concurrent claimant or unusable entry leaves ordinary replay available. */ }
    }
    available.sort((first, second) => second.at - first.at);
    if (sweep) for (const checkpoint of available.slice(maxEntries)) take(checkpoint);
    return available.slice(0, maxEntries);
  }

  return {
    save(record) {
      try {
        if (Date.now() - lastSweep >= 60000) entries();
        const file = join(stateDirectory(), `${randomUUID()}.json`);
        const { agent, historyLength, historyHash, toolConfig, caller, launchHash, model, effort } = record;
        const row = { version: 1, pid: process.pid, at: Date.now(), sessionId: record.session.sessionId,
          ...(agent === 'grok' && { agent }), historyLength, historyHash, toolConfig, caller, launchHash, model, effort };
        if (!validCheckpoint(row)) return undefined;
        writeAtomic(file, row);
        return { file };
      } catch { return undefined; }
    },
    take,
    claim(matches) {
      try {
        const entry = entries().filter(matches).sort((first, second) => second.historyLength - first.historyLength)[0];
        return entry && take(entry) ? entry : undefined;
      } catch { return undefined; }
    },
    release({ file }) {
      try {
        stateDirectory();
        writeFileSync(`${file}.released`, '', { flag: 'wx', mode: 0o600 });
      } catch { /* Recovery remains available after process exit. */ }
    },
  };
}
