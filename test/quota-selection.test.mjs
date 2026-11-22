import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { providerHooks } from '../lib/provider.mjs';
import { agentsFromModelIds, enabledQuotaAgents } from '../lib/quota-selection.mjs';

const checklist = (models) => JSON.stringify({
  providers: [{ id: 'deepseek', key: 'secret', models: ['deepseek-flash'] }, { id: 'local-cli', models }],
});

test('checked model ids select a CLI, and an Antigravity Claude model is not Claude Code', () => {
  assert.deepEqual([...agentsFromModelIds([
    'antigravity-gemini-3.8-flash',
    'antigravity-claude-opus-4-6-thinking',
  ])], ['antigravity']);
  assert.deepEqual([...agentsFromModelIds(['codex-default', 'grok-grok-4.7', 'claude-opus'])].sort(), ['claude', 'codex', 'grok']);
  assert.equal(agentsFromModelIds([]).size, 0);
});

test('a missing or unreadable checklist queries every CLI, and an empty pick queries none', () => {
  assert.equal(enabledQuotaAgents(null), null);
  assert.equal(enabledQuotaAgents('{'), null);
  assert.equal(enabledQuotaAgents(JSON.stringify({ providers: [] })), null);
  assert.equal(enabledQuotaAgents(JSON.stringify({ providers: [{ id: 'local-cli' }] })), null);
  assert.equal(enabledQuotaAgents(checklist([])).size, 0);
  assert.deepEqual([...enabledQuotaAgents(checklist(['antigravity-gemini-3.8-flash']))], ['antigravity']);
});

test('usage reads only the CLIs whose models are checked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'magpie-quota-selection-'));
  const calls = [];
  const reader = (agent) => async () => {
    calls.push(agent);
    return { windows: [{ name: agent, pool: agent, used: 1 }], readAt: '2026-11-22T00:00:00.000Z' };
  };
  try {
    const hooks = providerHooks(root, {
      readSelection: () => checklist(['antigravity-gemini-3.8-flash', 'antigravity-claude-opus-4-6-thinking']),
      quotaReaders: { antigravity: reader('antigravity'), codex: reader('codex'), grok: reader('grok'), claude: reader('claude') },
    });
    const shown = await hooks.auth.usage(async () => ({ key: 'local-cli-linked' }));
    assert.deepEqual(calls, ['antigravity']);
    assert.deepEqual(shown.windows.map(({ name }) => name), ['antigravity']);

    calls.length = 0;
    const none = providerHooks(root, {
      readSelection: () => checklist([]),
      quotaReaders: { antigravity: reader('antigravity'), codex: reader('codex'), grok: reader('grok'), claude: reader('claude') },
    });
    assert.deepEqual(await none.auth.usage(async () => ({ key: 'local-cli-linked' })), { windows: [] });
    assert.deepEqual(calls, []);

    const everyone = providerHooks(root, {
      readSelection: () => null,
      quotaReaders: { antigravity: reader('antigravity'), codex: reader('codex'), grok: reader('grok'), claude: reader('claude') },
    });
    await everyone.auth.usage(async () => ({ key: 'local-cli-linked' }));
    assert.deepEqual(calls, ['antigravity', 'codex', 'grok', 'claude']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
