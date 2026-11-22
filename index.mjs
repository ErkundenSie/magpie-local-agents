import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents, launchAgent, workspace } from './lib/launch.mjs';
import { displayError, stopChildren } from './lib/rpc.mjs';
import { AgentSession } from './lib/session.mjs';
import { ToolBridge } from './lib/tool-bridge.mjs';
import { providerHooks } from './lib/provider.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
// Magpie's path-plugin watcher deliberately skips dot directories.
const runtimeDir = join(root, 'page', '.runtime');
const bootstrap = join(runtimeDir, 'session.js');
const host = '127.0.0.1';
const maxSockets = 12;
const delay = 700;
const noCache = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const assets = new Map([
  ['/app', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

function validSecret(candidate, expected) {
  return typeof candidate === 'string' && /^[0-9a-f]{64}$/.test(candidate) &&
    timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(expected, 'hex'));
}

// Windows cannot rename over an existing file, and the file is rewritten on
// every restart, so write it in place: boot.js re-reads with a cache buster
// and retries, so a reader never latches onto a torn copy.
function writeBootstrap(port, key) {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(bootstrap, `globalThis.localCliBootstrap = ${JSON.stringify({ port, key, pid: process.pid })};\n`, { mode: 0o600 });
}

function removeOwnedBootstrap(key) {
  try {
    if (readFileSync(bootstrap, 'utf8').includes(`"${key}"`)) unlinkSync(bootstrap);
  } catch { /* Another host may own this file. */ }
}

function removeStaleBootstrap() {
  let pid;
  try {
    const file = readFileSync(bootstrap, 'utf8');
    const match = /^globalThis\.localCliBootstrap = (\{[^\r\n]+\});\r?\n?$/.exec(file);
    if (!match) return;
    const value = JSON.parse(match[1]);
    pid = value.pid;
    if (!Number.isInteger(pid) || pid < 1 || !/^[a-f0-9]{64}$/.test(value.key)) return;
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') removeOwnedBootstrap(value.key); }
  } catch { /* No previous host to recover. */ }
}

function send(ws, event) {
  if (ws.readyState === 1 && ws.send(JSON.stringify(event)) === 0) ws.close(1013, 'Receiver disconnected');
}

function cancel(ws) {
  const run = ws.data.run;
  if (!run || run.cancelled) return;
  run.cancelled = true;
  ws.data.session?.cancel();
  run.timer = setTimeout(() => ws.data.run === run && ws.data.session?.close(), 5500);
}

async function prompt(ws, message) {
  const state = ws.data;
  if (state.run) throw new Error('A turn is already running.');
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text || text.length > 32000) throw new Error('Enter a prompt of 1–32,000 characters.');
  const run = { cancelled: false };
  state.run = run;
  let reason = 'error';
  send(ws, { type: 'start' });
  try {
    const cwd = workspace(message.cwd);
    const old = state.session;
    if (!old || old.closed || old.agent !== message.agent || old.cwd !== cwd) {
      old?.close();
      state.session = undefined;
      const launch = launchAgent(root, message.agent, cwd);
      const session = new AgentSession(message.agent, launch, (event) => send(ws, event));
      state.session = session;
      await session.start();
    }
    if (run.cancelled) {
      reason = 'cancelled';
    } else {
      reason = await state.session.prompt(text);
    }
  } catch (error) {
    state.session?.close();
    state.session = undefined;
    if (run.cancelled) reason = 'cancelled';
    else send(ws, { type: 'error', message: displayError(error.message) });
  } finally {
    clearTimeout(run.timer);
    state.session?.clearApprovals();
    state.run = undefined;
    send(ws, { type: 'done', reason });
  }
}

async function dispatch(ws, raw, token) {
  if (typeof raw !== 'string') return ws.close(1003, 'Text frames only');
  let message;
  try { message = JSON.parse(raw); } catch { return ws.close(1007, 'Invalid JSON'); }
  if (!ws.data.authenticated) {
    if (message?.type !== 'hello' || !validSecret(message.token, token)) return ws.close(4401, 'Invalid capability');
    clearTimeout(ws.data.authTimer);
    ws.data.authenticated = true;
    return send(ws, { type: 'ready', cwd: homedir(), agents: listAgents(root) });
  }
  try {
    switch (message?.type) {
      case 'prompt': await prompt(ws, message); break;
      case 'cancel': cancel(ws); break;
      case 'decision': ws.data.session?.decide(message.id, message.optionId); break;
      case 'reset':
        if (ws.data.run) throw new Error('Stop the current turn before starting a new session.');
        ws.data.session?.close();
        ws.data.session = undefined;
        send(ws, { type: 'reset' });
        break;
      default: throw new Error('Unknown page action.');
    }
  } catch (error) {
    send(ws, { type: 'error', message: displayError(error.message) });
  }
}

function bind(port, key, token, bridge) {
  const assetFiles = new Map([...assets].map(([route, [file, mime]]) => [route, [readFileSync(join(root, 'app', file)), mime]]));
  const sockets = new Set();
  const instance = Bun.serve({
    hostname: host,
    port,
    fetch(request, server) {
      const authority = `${host}:${server.port}`;
      const origin = request.headers.get('origin');
      if (request.headers.get('host') !== authority) return new Response(null, { status: 421, headers: noCache });
      const url = new URL(request.url);
      // The MCP executable a local CLI spawns talks to this endpoint. It sends
      // no Origin, and a tool call may wait for the caller for minutes.
      const toolRoute = /^\/mcp\/([a-f0-9]{64})$/.exec(url.pathname);
      if (toolRoute) {
        if (origin !== null) return new Response(null, { status: 403, headers: noCache });
        try { server.timeout?.(request, 0); } catch { /* older host */ }
        return bridge.handle(request, toolRoute[1]);
      }
      if (request.method !== 'GET') return new Response(null, { status: 405, headers: noCache });
      if (url.pathname === '/socket') {
        if (origin !== 'null' && origin !== `http://${authority}`) return new Response(null, { status: 403, headers: noCache });
        if (sockets.size >= maxSockets) return new Response(null, { status: 503, headers: noCache });
        if (server.upgrade(request, { data: {} })) return undefined;
        return new Response(null, { status: 400, headers: noCache });
      }
      if (origin !== null) return new Response(null, { status: 403, headers: noCache });
      if (url.pathname === '/open') {
        if (!validSecret(url.searchParams.get('k'), key)) return new Response(null, { status: 403, headers: noCache });
        const query = new URLSearchParams();
        const theme = url.searchParams.get('theme');
        const lang = url.searchParams.get('lang');
        if (['light', 'dark'].includes(theme)) query.set('theme', theme);
        if (lang && /^[a-zA-Z0-9-]{1,20}$/.test(lang)) query.set('lang', lang);
        return new Response(null, { status: 302, headers: { ...noCache, Location: `/app?${query}#t=${token}` } });
      }
      const asset = assetFiles.get(url.pathname);
      if (!asset) return new Response(null, { status: 404, headers: noCache });
      const policy = [
        "default-src 'none'", `script-src http://${authority}`, `style-src http://${authority}`,
        `connect-src ws://${authority}`, "base-uri 'none'", "form-action 'none'",
        "frame-ancestors 'self' http://wails.localhost:* wails: http://127.0.0.1:* http://localhost:* http://[::1]:*",
      ];
      return new Response(asset[0], {
        headers: { ...noCache, 'Content-Type': asset[1], 'Content-Security-Policy': policy.join('; ') },
      });
    },
    websocket: {
      maxPayloadLength: 256 * 1024,
      backpressureLimit: 2 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 180,
      open(ws) {
        sockets.add(ws);
        ws.data.authTimer = setTimeout(() => ws.close(4401, 'Authentication timed out'), 5000);
      },
      message(ws, raw) { void dispatch(ws, raw, token); },
      close(ws) {
        sockets.delete(ws);
        clearTimeout(ws.data.authTimer);
        clearTimeout(ws.data.run?.timer);
        if (ws.data.run) ws.data.run.cancelled = true;
        ws.data.session?.close();
      },
    },
  });
  return instance;
}

// Magpie invokes the OpenCode-compatible server hook in its Bun plugin host.
export function server(_input = {}, options = {}) {
  const port = Number(options?.port ?? process.env.MAGPIE_LOCAL_CLI_PORT ?? 3496);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local CLI: invalid service port');
  removeStaleBootstrap();
  const key = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const bridge = new ToolBridge({ getPort: () => instance?.port ?? port });
  let instance;
  let timer;
  let beat;
  let attempts = 0;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    try {
      instance = bind(port, key, token, bridge);
      writeBootstrap(instance.port, key);
      // A short-lived host (a magpie CLI subcommand, say) can be killed between
      // bind and exit; re-asserting the file keeps the page's bootstrap alive.
      // A failed rewrite must never take the host down.
      beat = setInterval(() => {
        if (!instance) return;
        try { writeBootstrap(instance.port, key); }
        catch (error) { console.error(`Local CLI could not refresh its page bootstrap: ${displayError(error.message)}`); }
      }, 5000);
      beat.unref?.();
    } catch (error) {
      instance?.stop(true);
      instance = undefined;
      if (error.code === 'EADDRINUSE' && ++attempts < 25) {
        timer = setTimeout(start, 1500);
      } else {
        console.error(`Local CLI could not start on port ${port}: ${displayError(error.message)}`);
      }
    }
  };
  const onExit = () => {
    removeOwnedBootstrap(key);
    stopChildren();
  };
  const { stop: stopProvider, ...hooks } = providerHooks(root, { bridge });
  const stop = () => {
    stopped = true;
    stopProvider();
    clearTimeout(timer);
    clearInterval(beat);
    instance?.stop(true);
    removeOwnedBootstrap(key);
    process.off('exit', onExit);
  };
  process.on('exit', onExit);
  timer = setTimeout(start, delay);
  return { stop, ...hooks };
}
