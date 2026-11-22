import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('../lib/mcp-stdio.mjs', import.meta.url));
const tokenPath = '/mcp/test-token';
const latest = '2025-06-18';
const tools = [
  {
    name: 'search',
    description: 'Look up a term',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'open',
    description: 'Open a file',
    inputSchema: { type: 'object', properties: {} },
  },
];

// A throwaway stand-in for the plugin's tool bridge. It records exactly what
// the executable posts so the test can assert the wire shape too.
function createServer({ delayMs = 50 } = {}) {
  const requests = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== 'POST') {
        return Response.json({ error: { code: -32600, message: 'POST required' } }, { status: 405 });
      }
      if (url.pathname !== tokenPath) {
        return Response.json({ error: { code: -32001, message: 'Unknown tool session' } }, { status: 404 });
      }
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: { code: -32600, message: 'Invalid JSON body' } }, { status: 400 });
      }
      requests.push({ path: url.pathname, body });
      if (body?.method === 'tools/list') return Response.json({ result: { tools } });
      if (body?.method === 'tools/call') {
        await Bun.sleep(delayMs);
        const name = body.params?.name;
        const args = body.params?.arguments;
        return Response.json({
          result: { content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }], isError: false },
        });
      }
      return Response.json({ error: { code: -32601, message: 'Unsupported tool method' } }, { status: 400 });
    },
  });
  return { server, requests, url: `http://127.0.0.1:${server.port}${tokenPath}` };
}

// Incremental line reader: every non-empty stdout line is recorded, parsed
// when possible, and handed to sequential waiters.
function readLines(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const entries = [];
  const waiters = new Set();
  let buffer = '';
  let ended = false;
  let cursor = 0;

  const record = (raw) => {
    const line = raw.replace(/\r$/, '').trim();
    if (!line) return;
    try {
      entries.push({ line, value: JSON.parse(line), valid: true });
    } catch {
      entries.push({ line, value: undefined, valid: false });
    }
    for (const waiter of [...waiters]) waiter();
  };

  const done = (async () => {
    try {
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) !== -1) {
          record(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
      }
      buffer += decoder.decode();
      if (buffer) record(buffer);
    } catch {
      // Cleanup may tear the stream down; recorded lines are still valid.
    } finally {
      ended = true;
      for (const waiter of [...waiters]) waiter();
    }
  })();

  async function next(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (cursor < entries.length) {
        const entry = entries[cursor++];
        if (!entry.valid) throw new Error(`stdout carried a non-JSON line: ${entry.line}`);
        return entry.value;
      }
      if (ended) throw new Error('The bridge exited before replying.');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for a bridge reply.');
      await new Promise((resolve) => {
        const timer = setTimeout(finish, remaining);
        function finish() {
          clearTimeout(timer);
          waiters.delete(finish);
          resolve();
        }
        waiters.add(finish);
      });
    }
  }

  return { next, entries, done };
}

function startBridge(endpoint) {
  const env = { ...process.env };
  if (endpoint === undefined) delete env.MAGPIE_LOCAL_CLI_MCP;
  else env.MAGPIE_LOCAL_CLI_MCP = endpoint;
  const proc = Bun.spawn({
    cmd: [process.execPath, scriptPath],
    cwd: root,
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = readLines(proc.stdout);
  const stderrText = new Response(proc.stderr).text().catch(() => '');
  return {
    proc,
    stdout,
    stderrText,
    async send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
      await proc.stdin.flush();
    },
    async sendRaw(text) {
      proc.stdin.write(text);
      await proc.stdin.flush();
    },
    async closeInput() {
      try { proc.stdin.end(); } catch { /* already closed */ }
    },
  };
}

function waitForExit(proc, timeoutMs = 3000) {
  return Promise.race([
    proc.exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('The bridge process did not exit.')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

async function cleanup(proc, server) {
  try { proc.stdin?.end(); } catch { /* already closed */ }
  try { proc.kill(); } catch { /* already exited */ }
  try { await proc.exited; } catch { /* already reaped */ }
  try { server?.stop(true); } catch { /* already stopped */ }
}

test('negotiates protocol versions and forwards tools requests to the plugin', async () => {
  const { server, requests, url } = createServer();
  const bridge = startBridge(url);
  try {
    let id = 0;
    for (const protocolVersion of ['2025-06-18', '2025-03-26', '2024-11-05']) {
      id += 1;
      await bridge.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion } });
      expect(await bridge.stdout.next()).toEqual({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'magpie-local-cli-tools', version: '0.3.0' },
        },
      });
    }

    // An unknown requested version falls back to the latest supported one.
    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    expect((await bridge.stdout.next()).result.protocolVersion).toBe(latest);

    // initialized is a notification: no reply may be emitted for it.
    await bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'ping' });
    expect(await bridge.stdout.next()).toEqual({ jsonrpc: '2.0', id, result: {} });

    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'tools/list' });
    expect(await bridge.stdout.next()).toEqual({ jsonrpc: '2.0', id, result: { tools } });
    expect(requests).toContainEqual({ path: tokenPath, body: { method: 'tools/list' } });

    // The fake bridge sleeps, so a reply that arrives proves the call waited.
    id += 1;
    const started = performance.now();
    await bridge.send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'search', arguments: { query: '窗' } },
    });
    const call = await bridge.stdout.next();
    expect(performance.now() - started).toBeGreaterThanOrEqual(35);
    expect(call).toEqual({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: 'search:{"query":"窗"}' }], isError: false },
    });
    expect(requests).toContainEqual({
      path: tokenPath,
      body: { method: 'tools/call', params: { name: 'search', arguments: { query: '窗' } } },
    });

    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'no/such/method' });
    expect(await bridge.stdout.next()).toEqual({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    });

    // Invalid params are rejected locally, without reaching the plugin.
    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { arguments: {} } });
    expect((await bridge.stdout.next()).error.code).toBe(-32602);
    expect(requests.filter(({ body }) => body.method === 'tools/call')).toHaveLength(1);

    // Malformed input is only logged to stderr, never echoed to stdout.
    await bridge.sendRaw('{not json}\n');
    id += 1;
    await bridge.send({ jsonrpc: '2.0', id, method: 'ping' });
    expect(await bridge.stdout.next()).toEqual({ jsonrpc: '2.0', id, result: {} });

    await bridge.closeInput();
    expect(await waitForExit(bridge.proc)).toBe(0);
    await bridge.stdout.done;

    // Exactly the ten replies above: every stdout line is JSON and nothing else.
    expect(bridge.stdout.entries).toHaveLength(10);
    expect(bridge.stdout.entries.filter((entry) => !entry.valid)).toEqual([]);
    expect(await bridge.stderrText).toContain('invalid JSON');
  } finally {
    await cleanup(bridge.proc, server);
  }
});

test('answers pipelined requests without head-of-line blocking', async () => {
  const { server, url } = createServer({ delayMs: 150 });
  const bridge = startBridge(url);
  try {
    await bridge.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: {} } });
    await bridge.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    expect(await bridge.stdout.next()).toEqual({ jsonrpc: '2.0', id: 2, result: {} });
    expect(await bridge.stdout.next()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: 'search:{}' }], isError: false },
    });

    await bridge.closeInput();
    expect(await waitForExit(bridge.proc)).toBe(0);
    await bridge.stdout.done;
    expect(bridge.stdout.entries.filter((entry) => !entry.valid)).toEqual([]);
  } finally {
    await cleanup(bridge.proc, server);
  }
});

test('refuses to start without a loopback bridge endpoint', async () => {
  const endpoints = [undefined, 'http://10.0.0.1:9/mcp/token', 'https://127.0.0.1:9/mcp/token'];
  for (const endpoint of endpoints) {
    const bridge = startBridge(endpoint);
    try {
      expect(await waitForExit(bridge.proc)).toBe(1);
      await bridge.stdout.done;
      expect(bridge.stdout.entries).toEqual([]);
      expect(await bridge.stderrText).toContain('MAGPIE_LOCAL_CLI_MCP');
    } finally {
      await cleanup(bridge.proc);
    }
  }
});
