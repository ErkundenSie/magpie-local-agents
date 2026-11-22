// Two turns of one conversation against a real CLI: the second must reuse the
// live session instead of cold-starting. Costs a little account quota.
import { fileURLToPath } from 'node:url';

const [given, model = 'codex-default'] = process.argv.slice(2);
const root = given ?? fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const { providerHooks } = await import(`file:///${root}/lib/provider.mjs`);

const hooks = providerHooks(root, {});
const loader = await hooks.auth.loader(async () => ({ key: 'local-cli-linked' }));
const chat = async (messages) => {
  const started = Date.now();
  const response = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model, messages }),
  });
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content ?? body.error?.message ?? '';
  return { ms: Date.now() - started, text: String(text).trim() };
};

const first = await chat([{ role: 'user', content: 'Reply with the single word ALPHA and nothing else.' }]);
console.log(`turn 1: ${first.ms}ms ${JSON.stringify(first.text.slice(0, 40))}`);
const second = await chat([
  { role: 'user', content: 'Reply with the single word ALPHA and nothing else.' },
  { role: 'assistant', content: first.text },
  { role: 'user', content: 'Reply with the single word BETA and nothing else.' },
]);
console.log(`turn 2: ${second.ms}ms ${JSON.stringify(second.text.slice(0, 40))}`);
console.log(second.text.includes('BETA') && first.text.includes('ALPHA') ? 'reuse: OK' : 'reuse: WRONG ANSWER');
if (!(second.ms < first.ms)) console.log('note: turn 2 was not faster this time');
process.exit(0);
