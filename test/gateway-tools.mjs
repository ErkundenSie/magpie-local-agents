// End-to-end through a real Magpie gateway: the caller's tool must come back as
// a standard tool_calls response, and the resumed request must finish the turn.
const [base, key] = process.argv.slice(2);
const url = `${base.replace(/\/$/, '')}/v1/chat/completions`;
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer magpie' };
const model = 'local-cli/codex-test-model';
const tools = [{
  type: 'function',
  function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object', properties: { query: { type: 'string' } } } },
}];
const messages = [{ role: 'user', content: 'look it up' }];
const post = async (body) => {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

const first = await post({ model, messages, tools });
const choice = first.choices?.[0];
const call = choice?.message?.tool_calls?.[0];
if (choice?.finish_reason !== 'tool_calls' || !call) throw new Error(`no tool call: ${JSON.stringify(first).slice(0, 300)}`);
console.log(`gateway tool call: ${call.function.name} ${call.function.arguments}`);

const second = await post({
  model,
  messages: [...messages, choice.message, { role: 'tool', tool_call_id: call.id, content: 'found 42' }],
  tools,
});
const text = second.choices?.[0]?.message?.content ?? '';
if (!text.includes('tool said found 42')) throw new Error(`resume failed: ${JSON.stringify(second).slice(0, 300)}`);
console.log(`gateway resume: ${text.trim().slice(0, 80)}`);
console.log(`key: ${String(key).slice(0, 4)}…`);
