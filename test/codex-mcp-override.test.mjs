import assert from 'node:assert/strict';
import { test } from 'node:test';
import { codexMcpOverride } from '../lib/launch.mjs';

test('a remote Codex MCP server is disabled instead of rewritten as stdio', () => {
  assert.equal(codexMcpOverride('notion', { url: 'https://mcp.notion.com/mcp' }), 'mcp_servers.notion.enabled=false');
  assert.match(codexMcpOverride('ssh', { command: 'node', args: ['server.js'] }), /^mcp_servers\.ssh=\{command=/);
  assert.match(codexMcpOverride('ssh', { command: 'node', args: ['server.js'] }), /empty-mcp\.mjs/);
  assert.throws(() => codexMcpOverride('not.ok', { url: 'https://example.test' }), /cannot be isolated/);
});
