import { createHash, randomUUID } from 'node:crypto';

const maxTranscriptBytes = 2 * 1024 * 1024;
const functionName = /^[A-Za-z0-9_-]{1,64}$/;
// The name a caller declares. It travels to the CLI as an MCP tool name, so it
// may carry the separators MCP servers use.
const toolName = /^[A-Za-z0-9_.:-]{1,128}$/;
const messageRoles = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const encoder = new TextEncoder();

export class ChatError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ChatError';
    this.status = status;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const maxImageBytes = 8 * 1024 * 1024;

// imagePart reads one image part in either the Chat Completions shape
// (`image_url`) or the Responses shape (`input_image`). Only inline data URLs
// are accepted: Codex refuses remote image URLs outright, and fetching them
// here would turn a caller's URL into this host's request.
function imagePart(part, path, index) {
  const source = part?.image_url ?? part;
  const url = typeof source === 'string' ? source : source?.url;
  if (typeof url !== 'string') throw new ChatError(`${path} has no image URL.`);
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url.trim());
  if (!match) {
    throw new ChatError(`${path} must be an inline data URL; remote image URLs are not supported.`);
  }
  const [, mimeType, data] = match;
  if (!imageTypes.has(mimeType.toLowerCase())) throw new ChatError(`${path} has an unsupported image type (${mimeType}).`);
  if (Buffer.byteLength(data, 'base64') > maxImageBytes) throw new ChatError(`${path} is larger than 8 MiB.`);
  return { type: 'image', mimeType: mimeType.toLowerCase(), data, index };
}

function textContent(content, path, role, images) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw new ChatError(`${path} must contain text.`);
  const parts = content.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
    if (role === 'assistant' && part?.type === 'refusal' && typeof part.refusal === 'string') {
      return { type: 'refusal', refusal: part.refusal };
    }
    if (role === 'user' && (part?.type === 'image_url' || part?.type === 'input_image')) {
      const image = imagePart(part, path, images.length);
      images.push(image);
      // The digest keeps two different images at the same position from
      // looking identical to history matching.
      const digest = createHash('sha256').update(image.data).digest('hex').slice(0, 6);
      return { type: 'text', text: `[image ${images.length}: ${digest}]` };
    }
    throw new ChatError(`${path} only supports text${role === 'user' ? ' and inline images' : ''}.`);
  });
  return parts;
}

function historyMessage(message, index, images) {
  const path = `messages[${index}]`;
  if (!isObject(message) || !messageRoles.has(message.role)) throw new ChatError(`${path} has an unsupported role.`);
  const { role, content, name, tool_calls, tool_call_id, refusal } = message;
  const entry = { role };
  if (name !== undefined) {
    if (!isNonemptyString(name)) throw new ChatError(`${path}.name must be a nonempty string.`);
    entry.name = name;
  }
  if (message.audio != null) throw new ChatError(`${path}.audio is unsupported.`);
  if (message.function_call !== undefined) throw new ChatError(`${path}.function_call is unsupported. Use tool_calls.`);
  if (role !== 'assistant' && (tool_calls !== undefined || refusal !== undefined)) {
    throw new ChatError(`${path} has fields reserved for assistant messages.`);
  }
  if (role !== 'tool' && tool_call_id !== undefined) throw new ChatError(`${path}.tool_call_id requires the tool role.`);
  if (role === 'assistant') {
    if (refusal !== undefined) {
      if (refusal !== null && typeof refusal !== 'string') throw new ChatError(`${path}.refusal must be text or null.`);
      entry.refusal = refusal;
    }
    if (tool_calls !== undefined) {
      if (!Array.isArray(tool_calls)) throw new ChatError(`${path}.tool_calls must be an array.`);
      entry.tool_calls = tool_calls.map((call, callIndex) => {
        if (!isObject(call) || call.type !== 'function' || !isNonemptyString(call.id) ||
            !isObject(call.function) || typeof call.function.name !== 'string' ||
            !functionName.test(call.function.name) || typeof call.function.arguments !== 'string') {
          throw new ChatError(`${path}.tool_calls[${callIndex}] must be a function call with an ID and string arguments.`);
        }
        return { id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments } };
      });
    }
    if (content == null && (entry.tool_calls?.length || typeof refusal === 'string')) {
      if (content === null) entry.content = null;
      return entry;
    }
  }
  if (role === 'tool') {
    if (!isNonemptyString(tool_call_id)) throw new ChatError(`${path}.tool_call_id must be a nonempty string.`);
    entry.tool_call_id = tool_call_id;
  }
  entry.content = textContent(content, `${path}.content`, role, images);
  return entry;
}

const effortValues = new Set(['minimal', 'low', 'medium', 'high', 'xhigh']);

// reasoning_effort is the Chat Completions name; Responses nests it under
// `reasoning.effort`. Both reach the CLI the same way.
function parseEffort(body) {
  const raw = body.reasoning_effort ?? (isObject(body.reasoning) ? body.reasoning.effort : undefined);
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !effortValues.has(raw)) {
    throw new ChatError('reasoning_effort must be minimal, low, medium, high or xhigh.');
  }
  return raw;
}

// A tool definition is accepted the way clients actually send it: `description`
// and `parameters` may be null, and MCP-backed tools use dotted names such as
// `firecrawl.firecrawl_scrape`. Anything else is reported with the field at
// fault, because a caller cannot guess which of seventy tools was refused.
function parseTools(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ChatError('tools must be an array.');
  const names = new Set();
  return value.map((tool, index) => {
    const fn = tool?.function;
    const fail = (reason) => { throw new ChatError(`tools[${index}] ${reason}.`); };
    if (tool?.type !== 'function') fail(`has type ${JSON.stringify(tool?.type)} instead of "function"`);
    if (!isObject(fn)) fail('has no function object');
    if (typeof fn.name !== 'string' || !fn.name.trim()) fail('has no function name');
    if (!toolName.test(fn.name)) {
      fail(`has a name this gateway cannot forward (${JSON.stringify(fn.name.slice(0, 60))})`);
    }
    if (fn.description != null && typeof fn.description !== 'string') fail('has a non-text description');
    if (fn.parameters != null && !isObject(fn.parameters)) fail('has non-object parameters');
    if (fn.strict != null && typeof fn.strict !== 'boolean') fail('has a non-boolean strict flag');
    if (names.has(fn.name)) throw new ChatError(`Duplicate function name in tools: ${fn.name}.`);
    names.add(fn.name);
    const definition = { name: fn.name };
    if (typeof fn.description === 'string') definition.description = fn.description;
    // A tool without a schema still has to look like it takes an object.
    definition.parameters = fn.parameters ?? { type: 'object', properties: {} };
    if (typeof fn.strict === 'boolean') definition.strict = fn.strict;
    return { type: 'function', function: definition };
  });
}

function parseChoice(value, tools) {
  if (value === undefined) return tools.length ? 'auto' : 'none';
  if (value === 'auto' || value === 'none') return value;
  if (value === 'required' && tools.length) return value;
  if (isObject(value) && value.type === 'function' && isObject(value.function)) {
    const { name } = value.function;
    if (!tools.some((tool) => tool.function.name === name)) throw new ChatError('tool_choice names an undeclared function.');
    return { type: 'function', function: { name } };
  }
  throw new ChatError('tool_choice must be none, auto, required with tools, or a declared function.');
}

// The CLI sees a single text prompt. Tool responses are raw JSON envelopes with
// both fields present. A call contains a declared name and a JSON object of
// arguments. Auto and none also accept an ordinary text reply.
export function parseChatRequest(body, options = {}) {
  if (!isObject(body) || !isNonemptyString(body.model) || !Array.isArray(body.messages) || !body.messages.length) {
    throw new ChatError('A model and a nonempty messages array are required.');
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new ChatError('stream must be a boolean.');
  if (body.stream_options != null && (!isObject(body.stream_options) ||
      (body.stream_options.include_usage !== undefined && typeof body.stream_options.include_usage !== 'boolean'))) {
    throw new ChatError('stream_options.include_usage must be a boolean.');
  }
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') {
    throw new ChatError('parallel_tool_calls must be a boolean.');
  }
  if (body.functions !== undefined || body.function_call !== undefined) throw new ChatError('Use tools and tool_choice for function calls.');
  if (body.n != null && body.n !== 1) throw new ChatError('Only one completion choice is supported.');

  const images = [];
  const messages = body.messages.map((message, index) => historyMessage(message, index, images));
  const tools = parseTools(body.tools);
  const nativeTools = options.nativeTools === true && tools.length > 0;
  const toolChoice = parseChoice(body.tool_choice, tools);
  const toolMode = tools.length > 0;
  const parallelToolCalls = body.parallel_tool_calls ?? true;
  const effort = parseEffort(body);
  const context = { messages };
  if (toolMode) Object.assign(context, { tools, tool_choice: toolChoice, parallel_tool_calls: parallelToolCalls });
  const prompt = renderConversation(context, { nativeTools, toolMode, imageCount: images.length });

  return {
    model: body.model, stream: body.stream ?? false, includeUsage: body.stream_options?.include_usage === true,
    prompt, toolMode, tools, toolChoice, parallelToolCalls, messages, nativeTools, images, effort,
  };
}

// renderConversation is the single text a CLI is prompted with. A conversation
// a live CLI session already holds only needs the messages after it.
export function renderConversation(context, { nativeTools = false, toolMode = true, continuation = false, imageCount = 0 } = {}) {
  const toolLine = nativeTools
    ? 'The tools the caller offers are installed in this CLI as real tools. Call them normally when they help; the caller runs them and returns their results.'
    : 'Return the next assistant message as plain text.';
  const instructions = continuation
    ? ['These are only the messages added since your last reply in this conversation. Continue as the assistant from the conversation you already hold.', toolLine]
    : [
      'Continue the JSON conversation below as its assistant. Follow the system and developer messages and use the history in order.',
      nativeTools
        ? toolLine
        : toolMode
          ? 'Reply with one raw JSON object of the form {"content":"...","tool_calls":[{"name":"...","arguments":{}}]}. Use an empty content string for a reply without text and an empty tool_calls array for a reply without calls.'
          : toolLine,
    ];
  if (toolMode && !nativeTools && !continuation) {
    instructions.push('Only request declared functions. The caller executes the functions and returns their results in later tool messages. Follow tool_choice (none allows zero calls, auto allows zero or more, required needs at least one, and a named choice needs that function only. If parallel_tool_calls is false, make at most one call.');
  }
  if (imageCount > 0) {
    instructions.push(`The user attached ${imageCount} image${imageCount === 1 ? '' : 's'}; they follow this message as image content, in the order their [image N] markers appear.`);
  }
  let prompt;
  try {
    prompt = `${instructions.join('\n')}\n\n${continuation ? 'New messages' : 'Conversation'} JSON:\n${JSON.stringify(context)}`;
  } catch {
    throw new ChatError('The conversation must be JSON serializable.');
  }
  if (Buffer.byteLength(prompt, 'utf8') > maxTranscriptBytes) throw new ChatError('The conversation exceeds 2 MiB.');
  return prompt;
}

// A turn the CLI stops early is only an error when nothing was produced. Once
// part of the reply has streamed, the caller keeps it: reporting a transport
// failure there would throw away text the user can already read, and makes a
// client retry a request that did work.
function finishReason(reason, { partial = false } = {}) {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'completed': return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_turn_requests': return 'length';
    case 'content_filter':
    case 'refusal': return 'content_filter';
    case 'tool_calls': return 'tool_calls';
    case 'cancelled':
    case 'interrupted':
      // A truncated reply is reported as length, not stop: the caller has to
      // know the message was cut, or it stores half an answer as complete and
      // the model keeps talking past its own missing text.
      if (partial) return 'length';
      throw new DOMException('The CLI turn was cancelled.', 'AbortError');
    default: throw new ChatError(`The CLI ended the turn with an unsupported status (${String(reason)}).`, 502);
  }
}

function decodeOutput(request, text, reason) {
  let envelope;
  const invalid = () => new ChatError('The CLI returned an invalid tool response.', 502);
  if (request.toolMode) {
    try { envelope = JSON.parse(text); }
    catch {
      if (/^\s*\{\s*"(?:content|tool_calls)"/.test(text)) throw invalid();
    }
  }
  const choice = request.toolChoice;
  const named = typeof choice === 'object' ? choice.function.name : undefined;
  const requireCall = choice === 'required' || named !== undefined || reason === 'tool_calls';
  if (!isObject(envelope) || (!Object.hasOwn(envelope, 'content') && !Object.hasOwn(envelope, 'tool_calls'))) {
    if (requireCall) throw invalid();
    return { content: text, calls: [], reason };
  }
  const { content, tool_calls: requested } = envelope;
  if (typeof content !== 'string' || !Array.isArray(requested) ||
      (requireCall && !requested.length) || (choice === 'none' && requested.length) ||
      (!request.parallelToolCalls && requested.length > 1)) throw invalid();

  const allowed = new Set(request.tools.map((tool) => tool.function.name));
  const calls = requested.map((call) => {
    if (!isObject(call) || !allowed.has(call.name) || (named && call.name !== named) || !isObject(call.arguments)) {
      throw invalid();
    }
    const args = JSON.stringify(call.arguments, (_, value) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
      return value;
    });
    return {
      id: `call_${randomUUID().replaceAll('-', '')}`,
      type: 'function',
      function: { name: call.name, arguments: args },
    };
  });
  return { content, calls, reason: calls.length && reason === 'stop' ? 'tool_calls' : reason };
}

// nativeCalls validates tool calls the local CLI made through the caller's own
// MCP tools, which need no envelope decoding: the CLI already chose the name
// and the arguments natively.
function nativeCalls(request, requested) {
  const invalid = () => new ChatError('The CLI returned invalid tool calls.', 502);
  if (!Array.isArray(requested) || !requested.length) throw invalid();
  if (request.toolChoice === 'none') throw invalid();
  if (!request.parallelToolCalls && requested.length > 1) throw invalid();
  const named = typeof request.toolChoice === 'object' ? request.toolChoice.function.name : undefined;
  const allowed = new Set(request.tools.map((tool) => tool.function.name));
  return requested.map((call) => {
    const name = call?.name ?? call?.function?.name;
    const raw = call?.arguments ?? call?.function?.arguments;
    if (typeof name !== 'string' || !allowed.has(name) || (named && name !== named)) throw invalid();
    let args;
    if (typeof raw === 'string') {
      try { args = JSON.stringify(JSON.parse(raw)); } catch { throw invalid(); }
    } else if (isObject(raw)) {
      args = JSON.stringify(raw, (_, value) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw invalid();
        return value;
      });
    } else {
      throw invalid();
    }
    const id = typeof call?.id === 'string' && call.id.length <= 128 ? call.id : `call_${randomUUID().replaceAll('-', '')}`;
    return { id, type: 'function', function: { name, arguments: args } };
  });
}

async function complete(request, run, lifetime, onText, native) {
  const { signal } = lifetime;
  signal.throwIfAborted();
  const stopped = Promise.withResolvers();
  const onAbort = () => stopped.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  const parts = [];
  const buffered = !onText || (request.toolMode && !native);
  let active = true;
  try {
    const pending = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run({
        prompt: request.prompt,
        signal,
        emit(text) {
          if (!active || signal.aborted || text === '') return;
          if (typeof text !== 'string') {
            lifetime.abort(new ChatError('The CLI emitted a non-text fragment.', 502));
          } else {
            parts.push(text);
            if (!buffered) onText(text);
          }
        },
      });
    });
    const result = await Promise.race([pending, stopped.promise]);
    signal.throwIfAborted();
    const partial = parts.join('') !== '';
    if (native) {
      const calls = result?.toolCalls?.length ? nativeCalls(request, result.toolCalls) : [];
      const reason = calls.length ? 'tool_calls' : finishReason(result?.reason, { partial });
      return { content: parts.join(''), calls, reason, usage: result?.usage ?? undefined, streamed: !buffered };
    }
    const reason = finishReason(result?.reason, { partial });
    if (!buffered && reason === 'tool_calls') throw new ChatError('The CLI returned no validated tool calls.', 502);
    const reply = buffered ? decodeOutput(request, parts.join(''), reason) : { content: parts.join(''), calls: [], reason, streamed: true };
    return { ...reply, usage: result.usage ?? undefined };
  } finally {
    active = false;
    signal.removeEventListener('abort', onAbort);
  }
}

// run emits textual fragments synchronously through emit and returns a final
// reason and optional OpenAI-format usage. The optional signal belongs to the
// caller. The runner receives a signal linked to it and to SSE reader
// cancellation. options.nativeTools says the CLI holds the caller's tools as
// real MCP tools, so its calls arrive through run's result, not the envelope.
function assistantMessage(content, calls) {
  const message = { role: 'assistant', content: calls.length ? content || null : content };
  if (calls.length) message.tool_calls = calls;
  return message;
}

export async function serveChat(request, run, signal, options = {}) {
  const native = options.nativeTools === true && request.toolMode;
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  let cancelled = false;
  const onAbort = () => lifetime.abort(signal.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onAbort);
  const metadata = {
    id: `chatcmpl-${randomUUID().replaceAll('-', '')}`,
    created: Math.floor(Date.now() / 1000),
    model: request.model,
  };
  if (!request.stream) {
    try {
      const { content, calls, reason, usage } = await complete(request, run, lifetime, undefined, native);
      lifetime.signal.throwIfAborted();
      const message = assistantMessage(content, calls);
      options.onReply?.(message);

      return Response.json({ ...metadata, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: reason }], usage });
    } finally {
      cleanup();
    }
  }

  const ready = Promise.withResolvers();
  let started = false;
  const body = new ReadableStream({
    start(controller) {
      const send = (data) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      const frame = (choices, usage) => send(JSON.stringify({ ...metadata, object: 'chat.completion.chunk', choices, usage }));
      const choice = (delta, reason = null) => frame([{ index: 0, delta, finish_reason: reason }]);
      const startReply = () => {
        if (started) return;
        choice({ role: 'assistant' });
        started = true;
        ready.resolve();
      };
      void (async () => {
        try {
          const { content, calls, reason, usage, streamed } = await complete(request, run, lifetime, (text) => {
            startReply();
            choice({ content: text });
          }, native);
          lifetime.signal.throwIfAborted();
          startReply();
          if (content && !streamed) choice({ content });
          if (calls.length) choice({ tool_calls: calls.map((call, index) => ({ index, ...call })) });
          choice({}, reason);
          if (request.includeUsage && usage !== undefined) frame([], usage);
          options.onReply?.(assistantMessage(content, calls));
          send('[DONE]');
          controller.close();
        } catch (error) {
          options.onStreamError?.({ cancelled });
          // A reader that cancelled already closed this stream; only a real
          // failure is reported through it.
          if (!cancelled) {
            if (!started) ready.reject(error);
            controller.error(error);
          }
        } finally {
          cleanup();
        }
      })();
    },
    cancel(reason) {
      // The caller stopped reading: that is a finished response, not a
      // dropped connection, so it must not surface as a stream error.
      cancelled = true;
      lifetime.abort(reason);
    },
  });
  await ready.promise;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
