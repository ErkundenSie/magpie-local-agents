// Magpie keeps the checked models in providers.json, not in the usage hook.
// The hook is handed the full catalog, so the checklist is read here and
// dropped immediately: only local-cli model ids are kept, never the rest
// of that file.

const quotaAgents = ['antigravity', 'codex', 'grok', 'claude'];

export function agentsFromModelIds(ids) {
  const wanted = new Set();
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    const agent = quotaAgents.find((name) => id === name || id.startsWith(`${name}-`));
    if (agent) wanted.add(agent);
  }
  return wanted;
}

// null: the checklist could not be read, so every CLI is still queried.
// A set, possibly empty: only those CLIs. antigravity- is matched before
// claude-, so an Antigravity Claude model does not count as Claude Code.
export function enabledQuotaAgents(text) {
  if (typeof text !== 'string') return null;
  let doc;
  try { doc = JSON.parse(text); }
  catch { return null; }
  const providers = doc?.providers;
  if (!Array.isArray(providers)) return null;
  const row = providers.find((item) => item?.id === 'local-cli');
  if (!row || !Array.isArray(row.models)) return null;
  return agentsFromModelIds(row.models);
}
