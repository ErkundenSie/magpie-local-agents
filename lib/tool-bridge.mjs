import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const mcpServerPath = fileURLToPath(new URL('./mcp-stdio.mjs', import.meta.url));
const serverName = 'local_cli_tools';

function toolList(tools) {
  return tools.map(({ function: definition }) => ({
    name: definition.name,
    description: definition.description ?? '',
    inputSchema: definition.parameters ?? { type: 'object', properties: {} },
  }));
}

// ToolBridge turns the tools a gateway caller declared into MCP tools that the
// local CLI spawns and calls. A call parks the CLI turn until the caller's next
// request carries the result back under the same tool_call id.
export class ToolBridge {
  #getPort;
  #entries = new Map();
  #byCallId = new Map();

  constructor({ getPort }) {
    this.#getPort = getPort;
  }

  get endpoint() {
    return `http://127.0.0.1:${this.#getPort()}/mcp`;
  }

  // attach registers a conversation's tools and returns the MCP server spec the
  // CLI is launched with. Nothing is spawned here: the CLI starts it.
  attach(tools) {
    if (!tools.length) return undefined;
    const token = randomBytes(32).toString('hex');
    const entry = {
      token,
      tools: toolList(tools),
      record: undefined,
      spec: {
        name: serverName,
        command: process.execPath,
        args: [mcpServerPath],
        env: { MAGPIE_LOCAL_CLI_MCP: `${this.endpoint}/${token}` },
      },
    };
    this.#entries.set(token, entry);
    return entry;
  }

  close(token) {
    this.#entries.delete(token);
    for (const [id, call] of this.#byCallId) {
      if (call.token !== token) continue;
      this.#byCallId.delete(id);
      call.reject(new Error('The local CLI turn was closed before its tool result arrived.'));
    }
  }

  // has tells whether a call is still waiting, so a request is not matched to a
  // conversation whose tool call already expired.
  has(callId) {
    return this.#byCallId.has(callId);
  }

  // answer hands a caller's tool result to the blocked MCP call, which lets the
  // CLI continue the turn it never left.
  answer(callId, content, isError = false) {
    const call = this.#byCallId.get(callId);
    if (!call) return undefined;
    this.#byCallId.delete(callId);
    call.resolve({ content, isError });
    return true;
  }

  async #body(request) {
    const text = await request.text();
    if (Buffer.byteLength(text) > 1024 * 1024) throw Object.assign(new Error('Body too large'), { code: -32600 });
    try { return JSON.parse(text); } catch { throw Object.assign(new Error('Invalid JSON body'), { code: -32600 }); }
  }

  // handle serves the endpoint the MCP executable talks to.
  async handle(request, token) {
    const entry = this.#entries.get(token);
    if (!entry) return Response.json({ error: { code: -32001, message: 'This tool session has ended.' } }, { status: 404 });
    if (request.method !== 'POST') return Response.json({ error: { code: -32600, message: 'POST required' } }, { status: 405 });
    let body;
    try { body = await this.#body(request); }
    catch (error) { return Response.json({ error: { code: error.code ?? -32600, message: error.message } }, { status: 400 }); }

    if (body?.method === 'tools/list') return Response.json({ result: { tools: entry.tools } });
    if (body?.method !== 'tools/call') return Response.json({ error: { code: -32601, message: 'Unsupported tool method' } }, { status: 400 });
    const name = body.params?.name;
    const args = body.params?.arguments;
    if (typeof name !== 'string' || !entry.tools.some((tool) => tool.name === name) ||
        (args !== undefined && (args === null || typeof args !== 'object' || Array.isArray(args)))) {
      return Response.json({ error: { code: -32602, message: 'Unknown tool or invalid arguments' } }, { status: 400 });
    }

    const id = `call_${randomUUID().replaceAll('-', '')}`;
    const settled = new Promise((resolve, reject) => {
      this.#byCallId.set(id, { token, resolve, reject });
    });
    // The CLI is now blocked inside this call; the caller answers it in its
    // next request, so the turn is parked rather than drained here.
    entry.record?.onToolCall?.({ id, name, arguments: JSON.stringify(args ?? {}) });
    const outcome = await settled;
    return Response.json({
      result: { content: [{ type: 'text', text: String(outcome.content ?? '') }], isError: Boolean(outcome.isError) },
    });
  }
}
