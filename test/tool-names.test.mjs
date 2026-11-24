import { expect, test } from 'bun:test';
import { callerToolOf, exposeTools, isAgyCallerTool, isCatalogSearch, ToolBridge } from '../lib/tool-bridge.mjs';
import { gatewayProfile } from '../lib/launch.mjs';

const ssh = {
  type: 'function',
  function: {
    name: 'mcp__ssh__execute-command',
    description: 'Run a command on a remote host',
    parameters: { type: 'object', properties: { cmdString: { type: 'string' } } },
  },
};

test('a caller tool whose name contains __ is exposed with a single catalog delimiter', () => {
  const { listed, aliases } = exposeTools([
    ssh,
    { type: 'function', function: { name: 'mcp_ssh_execute-command', description: 'collision' } },
    { type: 'function', function: { name: 'a___b', description: '' } },
    { type: 'function', function: { name: '___', description: '' } },
    { type: 'function', function: { name: 'lookup', description: 'plain' } },
  ]);
  const names = listed.map((tool) => tool.name);
  expect(names[0]).toBe('mcp_ssh_execute-command');
  expect(names[1]).toBe('mcp_ssh_execute-command_2');
  expect(names[2]).toBe('a_b');
  expect(names[3]).toBe('tool');
  expect(names[4]).toBe('lookup');
  for (const name of names) {
    expect(name.includes('__')).toBe(false);
    expect(name.startsWith('_')).toBe(false);
    expect(`local_cli_tools__${name}`.length).toBeLessThanOrEqual(256);
  }
  expect(aliases.get('mcp_ssh_execute-command')).toBe('mcp__ssh__execute-command');
  expect(listed[0].description.startsWith('Known to the caller as mcp__ssh__execute-command.')).toBe(true);
  expect(listed[4].description).toBe('plain');
});

test('a sanitized tool call is reported under the caller name', async () => {
  const bridge = new ToolBridge({ getPort: () => 0 });
  const entry = bridge.attach([ssh]);
  let seen;
  entry.record = { onToolCall: (call) => { seen = call; bridge.answer(call.id, 'ok'); } };
  const response = await bridge.handle(new Request('http://127.0.0.1/mcp', {
    method: 'POST',
    body: JSON.stringify({
      method: 'tools/call',
      params: { name: 'mcp_ssh_execute-command', arguments: { cmdString: 'free -h' } },
    }),
  }), entry.token);
  expect(response.status).toBe(200);
  expect(seen.name).toBe('mcp__ssh__execute-command');
  expect(JSON.parse(seen.arguments)).toEqual({ cmdString: 'free -h' });
});

test('permission matching accepts the catalog key and a use_tool argument', () => {
  const tools = [ssh];
  expect(callerToolOf({ name: 'mcp__ssh__execute-command' }, tools)).toBe('mcp__ssh__execute-command');
  expect(callerToolOf({ title: 'local_cli_tools__mcp_ssh_execute-command' }, tools)).toBe('mcp__ssh__execute-command');
  expect(callerToolOf({
    name: 'use_tool',
    rawInput: { tool_name: 'local_cli_tools__mcp_ssh_execute-command', tool_input: {} },
  }, tools)).toBe('mcp__ssh__execute-command');
  expect(callerToolOf({ name: 'run_terminal_command' }, tools)).toBeNull();
  expect(callerToolOf({ name: 'use_tool', rawInput: { tool_name: 'grep' } }, tools)).toBeNull();
  expect(isCatalogSearch({ name: 'search_tool' })).toBe(true);
  expect(isCatalogSearch({ name: 'grep' })).toBe(false);
});

test('Antigravity ACP grants permission only for the exact namespaced caller tool', () => {
  const tools = [{ type: 'function', function: { name: 'docs__lookup-plan' } }];
  const name = 'mcp_local_cli_tools_docs_lookup-plan';
  expect(isAgyCallerTool({ name, title: `Run ${name}` }, tools)).toBe(true);
  expect(isAgyCallerTool({ name }, [])).toBe(false);
  expect(isAgyCallerTool({ name: 'mcp_other_tools_docs_lookup-plan' }, tools)).toBe(false);
  expect(isAgyCallerTool({ name: `${name}_extra` }, tools)).toBe(false);
  expect(isAgyCallerTool({ name: 'run_command', title: `Run ${name}`, rawInput: { tool_name: name } }, tools)).toBe(false);
});

test('the gateway profile hides the shell but keeps catalog meta-tools when the caller has tools', () => {
  const withTools = gatewayProfile(true);
  const without = gatewayProfile(false);
  for (const name of ['run_terminal_command', 'grep', 'write']) {
    expect(withTools).toContain(`  - ${name}`);
    expect(without).toContain(`  - ${name}`);
  }
  expect(withTools).not.toContain('  - search_tool');
  expect(withTools).not.toContain('  - use_tool');
  expect(without).toContain('  - search_tool');
  expect(without).toContain('  - use_tool');
});
