# Contributing

Thanks for taking a look. This is a small plugin with a deliberately narrow surface, so most contributions are one of: a new CLI adapter, a protocol detail that changed upstream, or a fix in the gateway translation layer.

## Before you start

The plugin never reads, stores, or refreshes subscription tokens, and it must never route a subscription through an API relay. A change that converts a subscription into API traffic, or that makes the plugin hold a vendor's credentials, will not be merged.

Two rules follow from that, and they are not negotiable:

- Every request to a CLI must go through the CLI's own login and its native endpoint.
- Gateway sessions stay constrained. If you add a CLI, it needs an isolation story as good as the existing ones (see the isolation table in the README) before it can be merged.

## Development

Requirements: [Bun](https://bun.sh) (Magpie's bundled runtime works too) and, for anything beyond the test suite, a real Magpie install.

```bash
bun test
```

The suite uses simulated protocol peers, so it spends no account quota. Keep it that way: new tests should not require a login.

If you are touching a real CLI, these scripts are manual and do spend quota:

```bash
bun test/real-tools-probe.mjs [model]
bun test/real-reuse-probe.mjs [model]
```

## What a good change looks like

- **One concern per pull request.** A protocol fix and a refactor land separately.
- **A test that fails before your change.** For protocol work, extend `test/fixture.mjs` or `test/fixture-tools.mjs` — they are the simulated peers, and they are how every existing protocol behaviour is pinned.
- **Errors name the thing at fault.** A caller sending seventy tools must be told which one was refused and why; "invalid request" is not enough.
- **No new dependencies.** The plugin ships with zero npm dependencies on purpose, so it loads instantly in Magpie's host. Use Node/Bun built-ins.
- **No secrets or machine paths.** Never commit `.local-agents.json`, tokens, or an absolute path from your own machine. Derive paths from `import.meta.url`.
- **Both READMEs, when behaviour changes.** `README.md` is the source of truth; `README.zh-CN.md` mirrors it.

## Adding a CLI adapter

1. Add the agent to the table in `lib/launch.mjs`, with its command and protocol.
2. Implement its session handling in `lib/session.mjs`. Codex speaks the App Server protocol; everything else goes through ACP v1, so check whether ACP already covers it before writing anything bespoke.
3. Add its gateway isolation flags in `lib/launch.mjs` — disable built-in tools, inherited MCP servers, skills and plugins, and keep only the caller's tool server.
4. Extend the fixtures so the new path is tested without a login.
5. Document it in the supported-CLI table of both READMEs, including what the user must install.

## Reporting a bug

Open an issue with the template. The useful details are: which CLI and version, which Magpie version, the exact error text, and whether the same request works through the CLI directly. If the payload is large, reduce it — a minimal reproducer is worth more than a full transcript.

## License

By contributing you agree your work is released under the [MIT License](LICENSE).
