import { fileURLToPath } from 'node:url';
import { displayError, stopChildren } from './lib/rpc.mjs';
import { ToolBridge } from './lib/tool-bridge.mjs';
import { providerHooks } from './lib/provider.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const host = '127.0.0.1';
const delay = 700;
const noCache = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};

function bind(port, bridge) {
  return Bun.serve({
    hostname: host,
    port,
    fetch(request, server) {
      const authority = `${host}:${server.port}`;
      if (request.headers.get('host') !== authority) return new Response(null, { status: 421, headers: noCache });
      const url = new URL(request.url);
      // The MCP executable a local CLI spawns talks to this endpoint. It sends
      // no Origin, and a tool call may wait for the caller for minutes.
      const toolRoute = /^\/mcp\/([a-f0-9]{64})$/.exec(url.pathname);
      if (!toolRoute) return new Response(null, { status: 404, headers: noCache });
      if (request.headers.get('origin') !== null) return new Response(null, { status: 403, headers: noCache });
      try { server.timeout?.(request, 0); } catch { /* older host */ }
      return bridge.handle(request, toolRoute[1]);
    },
  });
}

// Magpie invokes the OpenCode-compatible server hook in its Bun plugin host.
export function server(_input = {}, options = {}) {
  const port = Number(options?.port ?? process.env.MAGPIE_LOCAL_CLI_PORT ?? 3496);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local CLI: invalid service port');
  const bridge = new ToolBridge({ getPort: () => instance?.port ?? port });
  let instance;
  let timer;
  let attempts = 0;
  let stopped = false;
  const start = () => {
    if (stopped) return;
    try {
      instance = bind(port, bridge);
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
  const onExit = () => stopChildren();
  const { stop: stopProvider, ...hooks } = providerHooks(root, { bridge });
  const stop = () => {
    stopped = true;
    const retired = stopProvider();
    clearTimeout(timer);
    instance?.stop(true);
    process.off('exit', onExit);
    return retired;
  };
  process.on('exit', onExit);
  timer = setTimeout(start, delay);
  return { stop, ...hooks };
}
