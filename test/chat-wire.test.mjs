import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { ChatError, parseChatRequest, serveChat } from '../lib/chat-wire.mjs';

const search = {
  type: 'function',
  function: { name: 'search', description: 'Look up a term', parameters: { type: 'object' } },
};
const open = { type: 'function', function: { name: 'open' } };
const body = (options = {}) => ({ model: 'local-agent', messages: [{ role: 'user', content: '你好' }], ...options });
const parsed = (options) => parseChatRequest(body(options));
const named = (name) => ({ type: 'function', function: { name } });
const transcript = ({ prompt }) => JSON.parse(prompt.split('\nConversation JSON:\n')[1]);
const envelope = (calls, content = '') => JSON.stringify({ content, tool_calls: calls });
const call = (name = 'search', args = {}) => ({ name, arguments: args });
const runText = (text, reason = 'completed', usage) => async ({ emit }) => {
  emit(text);
  return { reason, usage };
};
const decode = (frame) => frame === 'data: [DONE]' ? '[DONE]' : JSON.parse(frame.slice('data: '.length));
const frames = async (response) => (await response.text()).trimEnd().split('\n\n').map(decode);
const failure = (status, message) => (error) => error instanceof ChatError && error.status === status && message.test(error.message);

async function nextFrame(reader) {
  const { value } = await reader.read();
  return decode(new TextDecoder().decode(value).trimEnd());
}

test('serializes the ordered conversation with text parts, tool call IDs and matching tool results', () => {
  const messages = [
    { role: 'system', content: 'System instructions' },
    { role: 'developer', name: 'app', content: [{ type: 'text', text: 'Developer instructions' }] },
    { role: 'user', content: [{ type: 'text', text: 'Look up \"窗\"\nThanks.' }] },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_previous', type: 'function', function: { name: 'earlier_tool', arguments: '{ "q": "窗" }' } },
    ] },
    { role: 'tool', tool_call_id: 'call_previous', content: [{ type: 'text', text: '{"result":"窗台"}' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Another turn.' }, { type: 'refusal', refusal: 'I cannot continue.' }] },
  ];
  const request = parsed({ messages, tools: [search], tool_choice: named('search'), parallel_tool_calls: false });
  assert.deepEqual(transcript(request), { messages, tools: [search], tool_choice: named('search'), parallel_tool_calls: false });
  assert.equal(request.model, 'local-agent');
  assert.equal(request.stream, false);
  assert.equal(request.toolMode, true);
  assert.deepEqual(request.tools, [search]);
  assert.deepEqual(request.toolChoice, named('search'));
});

test('keeps inline images as protocol blocks and marks their place in the transcript', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const url = `data:image/png;base64,${png}`;
  const request = parsed({ messages: [{ role: 'user', content: [
    { type: 'text', text: 'What is this?' },
    { type: 'image_url', image_url: { url } },
    { type: 'text', text: 'Thanks.' },
  ] }] });
  assert.equal(request.images.length, 1);
  assert.equal(request.images[0].mimeType, 'image/png');
  assert.equal(request.images[0].data, png);
  assert.equal(request.images[0].index, 0);
  // The base64 never reaches the prompt text; a stable marker stands in for it.
  assert.ok(!request.prompt.includes(png));
  assert.match(request.prompt, /\[image 1: [0-9a-f]{6}\]/);
  assert.match(request.prompt, /attached 1 image/);
  assert.deepEqual(transcript(request).messages[0].content.map((part) => part.text),
    ['What is this?', '[image 1: e42704]', 'Thanks.']);
});

test('accepts the tool shapes real clients send, including dotted MCP names and null fields', () => {
  const tools = Array.from({ length: 75 }, (_, index) => ({
    type: 'function',
    function: {
      name: index === 74 ? 'firecrawl.firecrawl_scrape' : `tool_${index}`,
      description: index % 2 ? null : `Tool ${index}`,
      parameters: index % 3 ? { type: 'object', properties: {} } : null,
    },
  }));
  const request = parseChatRequest(body({ tools }));
  assert.equal(request.tools.length, 75);
  assert.equal(request.tools[74].function.name, 'firecrawl.firecrawl_scrape');
  assert.deepEqual(request.tools[0].function.parameters, { type: 'object', properties: {} });
  assert.equal('description' in request.tools[1].function, false);
});

test('rejects malformed requests, unsupported content and oversized UTF-8 transcripts with status 400', () => {
  const invalid = [
    [null, /model/],
    [body({ model: ' ' }), /model/],
    [body({ reasoning_effort: 'extreme' }), /reasoning_effort/],
    [body({ messages: [] }), /messages/],
    [body({ messages: [{ role: 'function', content: '{}' }] }), /unsupported role/],
    [body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'example' } }] }] }), /inline data URL/],
    [body({ messages: [{ role: 'assistant', content: 'Audio reply', audio: { id: 'audio_id' } }] }), /audio is unsupported/],
    [body({ messages: [{ role: 'tool', content: '{}' }] }), /tool_call_id/],
    [body({ messages: [{ role: 'assistant', tool_calls: [{ id: 'call_id', type: 'function', function: { name: 'search', arguments: {} } }] }] }), /string arguments/],
    [body({ tools: [{ type: 'custom', custom: { name: 'lookup' } }] }), /instead of "function"/],
    [body({ tools: [search, search] }), /Duplicate/],
    [body({ tools: [search], tool_choice: named('open') }), /undeclared/],
    [body({ tool_choice: named('open') }), /undeclared/],
    [body({ tool_choice: 'required' }), /required with tools/],
    [body({ stream: 'true' }), /boolean/],
    [body({ parallel_tool_calls: 'false' }), /boolean/],
    [body({ messages: [{ role: 'user', content: '界'.repeat(700_000) }] }), /2 MiB/],
  ];
  for (const [request, message] of invalid) assert.throws(() => parseChatRequest(request), failure(400, message));
});

test('streams role and text as they arrive, then emits the finish reason and DONE', async () => {
  const finished = Promise.withResolvers();
  let emitText;
  const request = parsed({ stream: true });
  const response = await serveChat(request, ({ prompt, emit }) => {
    assert.equal(prompt, request.prompt);
    emitText = emit;
    emit('你');
    return finished.promise;
  });
  assert.match(response.headers.get('content-type'), /^text\/event-stream/);
  const reader = response.body.getReader();
  const role = await nextFrame(reader);
  assert.deepEqual(role.choices, [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
  assert.equal(role.object, 'chat.completion.chunk');
  assert.equal((await nextFrame(reader)).choices[0].delta.content, '你');
  emitText('好');
  assert.equal((await nextFrame(reader)).choices[0].delta.content, '好');
  finished.resolve({ reason: 'max_tokens' });
  const finish = await nextFrame(reader);
  assert.deepEqual(finish.choices, [{ index: 0, delta: {}, finish_reason: 'length' }]);
  assert.equal(finish.id, role.id);
  assert.equal(finish.model, 'local-agent');
  assert.equal(await nextFrame(reader), '[DONE]');
  assert.equal((await reader.read()).done, true);
});

test('produces standard tool call deltas the client can replay as assistant and tool messages', async () => {
  const request = parsed({ stream: true, tools: [search, open], tool_choice: 'required' });
  const response = await serveChat(request, async ({ emit }) => {
    emit('{"content":"Checking","tool_calls":[');
    emit('{"name":"search","arguments":{"q":"窗"}},');
    emit('{"name":"open","arguments":{"id":12}}]}');
    return { reason: 'end_turn' };
  });
  const [role, text, tools, finish, done] = await frames(response);
  assert.deepEqual(role.choices[0].delta, { role: 'assistant' });
  assert.deepEqual(text.choices[0].delta, { content: 'Checking' });
  const calls = tools.choices[0].delta.tool_calls;
  assert.deepEqual(calls.map(({ index, ...entry }) => ({ index, ...entry, id: '<generated>' })), [
    { index: 0, id: '<generated>', type: 'function', function: { name: 'search', arguments: '{"q":"窗"}' } },
    { index: 1, id: '<generated>', type: 'function', function: { name: 'open', arguments: '{"id":12}' } },
  ]);
  assert.notEqual(calls[0].id, calls[1].id);
  for (const { id } of calls) assert.match(id, /^call_[a-zA-Z0-9]+$/);
  assert.equal(finish.choices[0].finish_reason, 'tool_calls');
  assert.equal(done, '[DONE]');
  const messages = [
    { role: 'user', content: 'Find it' },
    { role: 'assistant', content: 'Checking', tool_calls: calls.map(({ id, type, function: fn }) => ({ id, type, function: fn })) },
    ...calls.map(({ id }) => ({ role: 'tool', tool_call_id: id, content: 'Found it' })),
  ];
  assert.deepEqual(transcript(parsed({ messages })).messages, messages);

  const responseJson = await serveChat(parsed({ tools: [search], tool_choice: named('search') }), runText(envelope([call()])));
  const [choice] = (await responseJson.json()).choices;
  assert.equal(choice.finish_reason, 'tool_calls');
  assert.equal(choice.message.content, null);
  assert.equal(choice.message.tool_calls[0].function.arguments, '{}');
});

test('permits auto and none text fallbacks and rejects forbidden or invalid tool responses before sending SSE', async () => {
  for (const toolChoice of ['auto', 'none']) {
    const response = await serveChat(parsed({ tools: [search], tool_choice: toolChoice }), runText('ordinary text'));
    const message = await response.json();
    assert.equal(message.object, 'chat.completion');
    assert.deepEqual(message.choices, [{ index: 0, message: { role: 'assistant', content: 'ordinary text' }, finish_reason: 'stop' }]);
    assert.equal(Object.hasOwn(message, 'usage'), false);
  }
  const invalid = [
    [{ tool_choice: 'required' }, 'cannot call' ],
    [{ tool_choice: named('search') }, envelope([])],
    [{ tool_choice: named('search') }, envelope([call('open')])],
    [{ tool_choice: 'none' }, envelope([call()])],
    [{ parallel_tool_calls: false }, envelope([call(), call()])],
    [{}, envelope([call('undeclared')])],
    [{}, envelope([call('search', [])])],
    [{}, envelope([call('search', '{"q":42}')])],
    [{}, '{"content":"","tool_calls": ['],
  ];
  for (const [options, text] of invalid) {
    await assert.rejects(serveChat(parsed({ stream: true, tools: [search, open], ...options }), runText(text)), failure(502, /invalid tool response/));
  }
});

test('passes through reported usage and omits it when the runner has no counts', async () => {
  const usage = { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 };
  const response = await serveChat(parsed(), runText('limited', 'content_filter', usage));
  const result = await response.json();
  assert.deepEqual(result.usage, usage);
  assert.equal(result.choices[0].finish_reason, 'content_filter');
  const streamed = parsed({ stream: true, stream_options: { include_usage: true } });
  const withUsage = await frames(await serveChat(streamed, runText('hello', 'stop', usage)));
  assert.deepEqual(withUsage.at(-2).choices, []);
  assert.deepEqual(withUsage.at(-2).usage, usage);
  const withoutUsage = await frames(await serveChat(streamed, runText('hello')));
  assert.equal(withoutUsage.at(-2).choices[0].finish_reason, 'stop');
  assert.ok(withoutUsage.slice(0, -1).every((frame) => !Object.hasOwn(frame, 'usage')));
});

test('rejects startup failures and errors an open stream after a runner failure', async () => {
  const request = parsed({ stream: true });
  const error = new Error('runner failed');
  await assert.rejects(serveChat(request, async () => { throw error; }), { message: error.message });
  const finished = Promise.withResolvers();
  const response = await serveChat(request, ({ emit }) => {
    emit('partial');
    return finished.promise;
  });
  const reader = response.body.getReader();
  assert.equal((await nextFrame(reader)).choices[0].delta.role, 'assistant');
  assert.equal((await nextFrame(reader)).choices[0].delta.content, 'partial');
  finished.reject(error);
  await assert.rejects(reader.read(), { message: error.message });
});

test('cancelling the reader closes a stream without reporting a transport error', async () => {
  const request = parsed({ stream: true });
  const running = Promise.withResolvers();
  let streamError;
  const response = await serveChat(request, ({ signal, emit }) => {
    emit('partial');
    running.resolve(signal);
    return new Promise(() => {});
  }, undefined, { onStreamError: (info) => { streamError = info; } });
  const signal = await running.promise;
  await response.body.cancel();
  await Promise.resolve();
  assert.equal(streamError.cancelled, true);
  assert.equal(signal.aborted, true);
  assert.equal((await response.body.getReader().read()).done, true);
});

test('keeps the text a CLI produced before it stopped the turn itself', async () => {
  const response = await serveChat(parsed(), runText('half an answer', 'cancelled'));
  const body = await response.json();
  assert.equal(body.choices[0].message.content, 'half an answer');
  assert.equal(body.choices[0].finish_reason, 'stop');

  // With nothing produced there is nothing to keep, so it stays an error.
  await assert.rejects(serveChat(parsed(), runText('', 'cancelled')), /cancelled/);
  await assert.rejects(serveChat(parsed(), runText('', 'interrupted')), /cancelled/);
});

test('propagates fetch abort before stream commitment and reader cancellation after it', async () => {
  const outer = new AbortController();
  const started = Promise.withResolvers();
  const ready = serveChat(parsed({ stream: true, tools: [search] }), ({ signal, emit }) => {
    emit('{"content":"buffered"');
    started.resolve(signal);
    return new Promise(() => {});
  }, outer.signal);
  const pending = await started.promise;
  const reason = new Error('fetch aborted');
  outer.abort(reason);
  await assert.rejects(ready, { message: reason.message });
  assert.equal(pending.reason, reason);

  const finished = Promise.withResolvers();
  const running = Promise.withResolvers();
  const response = await serveChat(parsed({ stream: true }), ({ signal, emit }) => {
    emit('first');
    running.resolve({ signal, emit });
    return finished.promise;
  });
  const { signal, emit } = await running.promise;
  await response.body.cancel('reader cancelled');
  assert.equal(signal.reason, 'reader cancelled');
  emit('late fragment');
  finished.reject(new Error('late runner rejection'));
  assert.equal((await response.body.getReader().read()).done, true);
});
