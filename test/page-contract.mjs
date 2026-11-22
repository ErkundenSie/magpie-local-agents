const [base, sessionCookie] = process.argv.slice(2);
const fail = (message) => { console.log('FAIL ' + message); process.exitCode = 1; };

const home = await fetch(`${base}/?k=${sessionCookie}`, { redirect: 'manual' });
const cookie = (home.headers.get('set-cookie') ?? '').split(';')[0];
const pages = await (await fetch(`${base}/api/plugin-pages`, { headers: { cookie } })).json();
const url = pages[0].url;
const dir = url.replace(/index\.html$/, '');
console.log(`plugin page: ${dir}`);

const html = await (await fetch(`${base}${dir}index.html`, { headers: { cookie } })).text();
const inlined = html.includes('localCliBootstrap') || !/src=["']boot\.js/.test(html);
console.log(`page document inlined: ${inlined} (${html.length} bytes)`);
if (!html.includes('本地 CLI') && !html.includes('Local CLI')) fail('page document lacks its title');

const boot = await fetch(`${base}${dir}.runtime/session.js`, { headers: { cookie } });
if (boot.status !== 200) fail(`bootstrap ${boot.status}`);
const bootText = await boot.text();
const key = /"key":"([a-f0-9]{64})"/.exec(bootText)?.[1];
const port = Number(/"port":(\d+)/.exec(bootText)?.[1]);
if (!key || !port) { fail('bootstrap incomplete'); process.exit(); }
console.log(`bootstrap: port=${port}`);

const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no ready frame')), 15000);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'hello', token: key })));
  socket.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data);
    if (event.type === 'ready') { clearTimeout(timer); resolve(event); }
  });
  socket.addEventListener('error', () => reject(new Error('socket error')));
}).catch((error) => { fail(error.message); return null; });
if (ready) {
  console.log(`ready: agents=${ready.agents.map((a) => a.id + (a.available ? '+' : '-')).join(' ')}`);
  socket.close();
}
