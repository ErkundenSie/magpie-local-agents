// Drives a real headless Chromium against a Magpie web instance and reports
// whether the plugin page inside Magpie's sandboxed frame reaches "ready".
// Usage: node test/browser-check.mjs <magpie-base-url> <MAGPIE_WEB_KEY> <chrome-path>
const [base, key, chrome] = process.argv.slice(2);
const { spawn } = await import('node:child_process');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const port = 3600 + Math.floor(Math.random() * 300);
const profile = mkdtempSync(join(tmpdir(), 'magpie-page-check-'));
const browser = spawn(chrome, ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let targets;
for (let i = 0; i < 40 && !targets; i++) {
  await sleep(250);
  targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => undefined);
}
if (!targets) { console.log('FAIL browser did not start'); browser.kill(); process.exit(1); }

const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let serial = 0;
const calls = new Map();
const contexts = [];
socket.onmessage = ({ data }) => {
  const event = JSON.parse(data);
  if (event.id && calls.has(event.id)) {
    const call = calls.get(event.id);
    calls.delete(event.id);
    event.error ? call.reject(new Error(event.error.message)) : call.resolve(event.result);
  }
  if (event.method === 'Runtime.executionContextCreated' && event.params.context.auxData?.isDefault) {
    contexts.push({ id: event.params.context.id, sessionId: event.sessionId });
  }
  if (event.method === 'Target.attachedToTarget') {
    void cmd('Runtime.enable', {}, event.params.sessionId);
    void cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, event.params.sessionId);
  }
};
const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++serial;
  calls.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params, sessionId }));
});

let found = false;
try {
  await cmd('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cmd('Runtime.enable');
  await cmd('Page.navigate', { url: `${base}/?k=${key}&view=plugin-magpie-local-agents` });
  for (let attempt = 0; attempt < 60 && !found; attempt++) {
    await sleep(400);
    await cmd('Runtime.evaluate', { expression: `(() => {
      const button = [...document.querySelectorAll('button')].find((node) => ['Local CLI', '本地 CLI'].includes(node.textContent.trim()));
      if (button && !document.querySelector('iframe[src*="/_magpie/plugin/"]')) button.click();
    })()` }).catch(() => {});
    for (const context of [...contexts]) {
      const probe = await cmd('Runtime.evaluate', {
        expression: `(() => { const el = document.querySelector('#connection-status'); return el ? { state: el.dataset.state, agents: document.querySelector('#agent-list')?.childElementCount, port: location.port } : null; })()`,
        contextId: context.id, returnByValue: true,
      }, context.sessionId).catch(() => null);
      const state = probe?.result?.value;
      if (state?.state === 'ready' && state.agents === 4) {
        console.log(`ready in Magpie's sandboxed frame: page service on ${state.port}, ${state.agents} agents`);
        found = true;
      }
    }
  }
  if (!found) console.log('FAIL the plugin page never reported ready');
} finally {
  socket.close();
  browser.kill();
}
process.exitCode = found ? 0 : 1;
