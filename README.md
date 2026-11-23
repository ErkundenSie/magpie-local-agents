# magpie-local-agents

[![test](https://github.com/ErkundenSie/magpie-local-agents/actions/workflows/test.yml/badge.svg)](https://github.com/ErkundenSie/magpie-local-agents/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/github/license/ErkundenSie/magpie-local-agents)](LICENSE)
[![Magpie](https://img.shields.io/badge/magpie-%E2%89%A50.1.4660-7c3aed)](https://usemagpie.ai)
[![runs on Bun](https://img.shields.io/badge/runs%20on-Bun-f472b6)](https://bun.sh)
[![no dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

Use the coding CLIs you are already signed in to — **Codex, Claude Code, Antigravity, Grok Build** — inside [Magpie](https://usemagpie.ai), and expose them through the Magpie gateway as a normal OpenAI-compatible provider.

The plugin drives each CLI as a child process over its own protocol (Codex App Server or ACP) and lets the CLI talk to its vendor with its own login. It never routes a subscription through an API relay. The only credential it ever reads is the Grok sign-in file, and only for the read-only quota check described below.

It appears as `Local CLI` in **Settings → Providers**, so any OpenAI-compatible client can call `local-cli/<agent>-<model>` through the gateway.

[中文说明](README.zh-CN.md)

## Requirements

- Magpie 0.1.4660 or newer. The plugin runs on Magpie's bundled Bun.
- At least one supported CLI, installed and signed in from your own terminal.

There are no npm dependencies and no build step.

## Install

From GitHub (recommended). Magpie's bundled Bun clones the repository, so `git` must be on `PATH`. `magpie plugin update` then picks up new commits on the default branch:

```powershell
magpie plugin add github:ErkundenSie/magpie-local-agents
magpie plugin login local-cli   # registers the local CLIs as a provider; no API key needed
```

`ErkundenSie/magpie-local-agents` and `git+https://github.com/ErkundenSie/magpie-local-agents.git` install the same package. In Magpie, open **Settings → Plugins → Add plugin** and enter that spec. Pin a tag or commit with `#ref`, for example `github:ErkundenSie/magpie-local-agents#v0.10.0`; a pinned commit is not offered as an update.

To work on a checkout instead, add the folder. Magpie loads it where it is and does not copy it:

```powershell
magpie plugin add 'D:\path\to\magpie-local-agents'
```

After editing that checkout, toggle the plugin off and on to reload it. A GitHub install is Magpie's own copy under its plugin directory; editing a separate clone does not change it.

The local tool bridge listens on loopback port `3496`. Set `MAGPIE_LOCAL_CLI_PORT` and restart Magpie if that port is taken.

## Using it as a provider

Models are named `local-cli/<agent>-<native model>`. An agent that reports no model list only exposes `<agent>-default`, which lets the CLI choose its own default model.

| Model | Meaning |
| --- | --- |
| `local-cli/codex-gpt-6.2-sol` | A native Codex model discovered from your account |
| `local-cli/codex-default` | Let Codex pick the native model |
| `local-cli/claude-default` | Claude Code's own default |
| `local-cli/antigravity-default` | Antigravity CLI's own default |
| `local-cli/grok-default` | Grok Build's own default |

Point any OpenAI-compatible client at the Magpie gateway (default `http://127.0.0.1:3425/v1`) with a gateway API key, then select one of those model names. Magpie translates between Chat Completions, Responses, and Anthropic Messages, so clients such as Claude Code or Codex work unmodified.

## What the gateway supports

### Client tools, passed through natively

Tools declared in the request become real MCP tools in front of the CLI: the plugin injects a local stdio MCP server into the CLI's configuration or `session/new`, so the model calls them directly and the CLI serializes the arguments itself.

When the CLI calls one, the plugin emits a standard `tool_calls` response and **parks the CLI turn**. When the caller comes back with `role: "tool"` results under the same `tool_call_id`, the plugin hands each result back to the blocked MCP call and the CLI continues the turn it never left, streamed as usual. This follows the same design as [`antigravity-bridge`](https://github.com/DylanLIiii/opencode-antigravity-bridge): multi-turn, parallel calls, and tool calls that take as long as they need — with the tool executing on the client, not in the CLI.

### Session reuse

Each request's history is compared against what a live session has already consumed — including the assistant replies and tool results the plugin itself returned. If they match, only the **new messages** are sent to the CLI. A rewritten assistant reply, a trimmed transcript, or a different toolset starts a fresh session and replays the full history. Two follow-ups branching from the same history get independent sessions, so they cannot contaminate each other.

Up to four live sessions are kept, each closed after ten minutes idle. This removes the cold start and the cost of resending the whole transcript on every turn.

After an Antigravity or Grok gateway turn completes, the plugin saves a local checkpoint with the native session ID and a history fingerprint. After a restart, matching history can resume through `session/resume` and send only new messages. If the CLI cannot resume the checkpoint, the plugin opens a fresh session and replays the client-provided history. Codex gateway threads stay ephemeral and are not resumed. An in-flight tool call cannot resume across restart. Checkpoints contain no message bodies, tool results, or credentials. By default they can be reused for up to six hours and live under `$XDG_STATE_HOME/magpie-local-agents` or `~/.local/state/magpie-local-agents`. Set `MAGPIE_LOCAL_CLI_AGY_RESUME_DIR` to an absolute path to change the location, or `MAGPIE_LOCAL_CLI_AGY_RESUME_TTL_MS=0` to disable restart recovery.

### Changing model and reasoning level mid-conversation

A different model in the same conversation switches the running session instead of restarting it: ACP goes through `session/set_config_option`, and Codex carries `model` on its next `turn/start`. The plugin falls back to a new session only when the CLI refuses the model.

`reasoning_effort` (or `reasoning.effort` in the Responses shape) accepts `minimal`, `low`, `medium`, `high`, and `xhigh`. Antigravity also accepts `max` if agy offers it. ACP uses the model's `thought_level` configuration when available. Codex sends `effort` with `turn/start`. An unsupported level on a native model leaves the CLI's current setting in place.

The Antigravity catalog lists the reasoning levels that agy reports for each model. When agy offers multiple effort-suffixed IDs for a family, the catalog also publishes a family alias with those levels. Existing native IDs remain callable. The alias defaults to `high` when offered or the highest listed level otherwise. Requesting an unavailable level on the alias returns HTTP 400.

Chat Completions returns CLI-emitted ACP thought text and Codex summaries in `reasoning_content`, separately from the reply text. Streaming clients receive it in a delta.

A turn that is already parked waiting for tool results cannot change model or level — that request starts a new session instead.

### Images

Send images as data URLs on a user message or a tool result: `{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}`. The plugin passes them to the CLI as native content: ACP takes `{type:"image", mimeType, data}`, and Codex takes an inline data URL. A tool result's images go back with that same call, as MCP image blocks in the order they were sent, while the CLI is still inside the call. They are not attached to a later prompt.

Images never enter the text prompt. A marker such as `[image 1: e42704]` takes their place, so history matching can still tell two different images at the same position apart. A picture that arrives on a later turn is sent with that turn; earlier ones stay in the session and are not sent again. Only inline data URLs are accepted (PNG, JPEG, WebP, GIF, up to 8 MiB each); remote image URLs are rejected rather than fetched, and the plugin does not read image files from disk. An agent that does not advertise image support returns 400 instead of silently dropping the image.

### Token usage

Usage is reported with each completed turn. Codex reports the per-turn delta of its thread-cumulative counters; ACP is read from `session/prompt`'s `usage`, and Grok also reports it under `_meta.usage`. Cache and reasoning breakdowns are passed through when the CLI provides them. With a tool call spanning several requests, usage arrives once with the final completed response. For streaming calls, `stream_options.include_usage: true` puts it in the last frame. When a CLI reports nothing, the field is omitted rather than guessed.

### Subscription quota

Magpie's Usage page shows subscription windows reported by the local CLIs under Local CLI. Use the card's refresh button or `magpie quota refresh local-cli` to request a fresh reading. A refresh queries only the CLIs that have a model checked. Antigravity's Gemini and Claude/GPT pools come from one reading, so checking any Antigravity model shows both. When that checklist cannot be read, every CLI is queried.

- **Antigravity** comes from `agy /usage`. The card labels those groups `Gemini (agy)` and `Claude/GPT (agy)`, instead of the CLI's own "Claude and GPT models".
- **Codex** comes from the app-server `account/rateLimits/read` method.
- **Grok** comes from a read-only `GET` to Grok's own billing endpoint, authorized with the xAI sign-in that `grok login` already stored in `~/.grok/auth.json`.

That Grok check is the one place the plugin reads a credential file. The token is read per check, used only for that one request to `cli-chat-proxy.grok.com`, and never written, logged, cached, refreshed, or sent anywhere else. Set `MAGPIE_LOCAL_CLI_GROK_QUOTA=0` to turn the check off entirely. When Grok is configured through `XAI_API_KEY`, `GROK_API_KEY` or `GROK_TOKEN`, there is no subscription window and nothing is read.

Claude Code reports its plan windows over ACP itself: the adapter sends them on `usage_update` notifications under `_meta["_claude/rateLimit"]` and on prompt results. Nothing is read from disk for Claude. Its card therefore appears after Claude's first gateway turn in this process, and its windows stop being shown 15 minutes after the last report. Every window is display-only and none of them change routing. Subscription windows and per-request token counts are reported separately.

### Errors

A CLI's own quota or rate-limit message (usage limit, rate limit, quota, HTTP 429) is returned as **429**, so a caller knows to wait. Everything else is **502**.

## Isolation

A gateway caller is a text client, not an interactive coding agent, so each request is constrained:

| CLI | Constraints in a gateway session |
| --- | --- |
| Codex | Read-only sandbox, `approvalPolicy: never`, ephemeral thread; shell tool, hooks, plugins, apps and web search disabled; each local MCP server replaced by a stub that offers no tools, and each remote `url` server disabled, keeping only the caller's tool server, with `default_tools_approval_mode = "approve"` to avoid an approval round-trip |
| Grok Build | Dedicated agent profile: built-ins stripped, `inheritMcp: false` so no global MCP servers, skills or plugins; the MCP meta-tools stay only when the caller declares tools |
| Antigravity CLI | `--settings` injects `permissions.deny`, denying commands, reads/writes and network by default; `mcp(*)` is left out unless the caller declares tools, with `toolPermission: strict` |
| Claude Code | `session/new` `_meta` sets `tools: []` to drop built-ins; `disallowedTools: ['*']` is not used when the caller declares tools, so their MCP tools survive |

Each CLI session runs in its own temporary directory, deleted when the session closes. Approval requests raised by the CLI itself are always declined; only tools the caller declared are allowed.

Limits: 2 MiB per request, 5 minutes per turn, 3 concurrent requests (429 beyond that), 8 parked turns kept for 10 minutes.

## Supported CLIs

| Agent | Launched as | Preparation |
| --- | --- | --- |
| OpenAI Codex | `codex app-server --listen stdio://` | Install OpenAI Codex and sign in from the CLI or the desktop app. On Windows the plugin also finds the executable bundled with the Microsoft Store build of Codex Desktop. |
| Claude Code | `claude-agent-acp`, wrapping your existing `claude` | Install native Claude Code and sign in. Also install [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp), e.g. `npm install -g @agentclientprotocol/claude-agent-acp`. |
| Antigravity CLI | `agy acp` | Install Google Antigravity CLI and sign in with `agy`. Gemini CLI was retired in favour of `agy`, so Antigravity is the Google option. |
| Grok Build | `grok agent --no-leader stdio` | Install xAI Grok Build and run `grok login`. |

The plugin runs executables by absolute path without a login shell, so it bypasses shell-profile functions Magpie injects.

If a launcher is missing or you need a pinned version, put `.local-agents.json` in the project root. Include only the fields you want to override, and replace the paths with your own:

```json
{
  "executables": {
    "codex": "D:/Tools/Codex/codex.exe",
    "claude": "D:/Tools/Claude/claude.exe",
    "claudeAdapter": "D:/Tools/Claude/claude-agent-acp.exe",
    "grok": "D:/Tools/Grok/grok.exe"
  }
}
```

`claude`, `antigravity` and `grok` work the same way. On Windows, `.exe` files run directly, and a standard npm `.cmd` shim (for anything other than Claude itself) is resolved to its JavaScript entry point and run with Node.

For Codex the plugin pins the OpenAI provider and clears any custom inference URL for that subprocess, so Codex uses its official endpoint through its own authentication. Other CLIs keep their native configuration; the plugin inspects common environment variables and config files and warns when a known custom model URL is set. Authentication, enterprise policy, system proxies, and CLI extensions remain with those programs.

The plugin does not manage `auth.json`, refresh tokens, or rewrite any CLI's user settings. Grok's sign-in file is read only for the quota check above and never written back. To undo a routing change, do it in that CLI or in Magpie. Whether a given subscription may be used in a given CLI or SDK is decided by that vendor's account and product rules.

## Development

```bash
bun test
```

CI runs the same command on every push and pull request. Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for the rules that matter here (no dependencies, no credentials, a test for every protocol change).

The suite uses simulated protocol peers, so it spends no account quota. It covers ACP multi-turn sessions, refusing a built-in tool without asking, allowing a caller tool once, a read-only ephemeral Codex thread, cancellation, the Codex early-completion race, gateway request validation, streaming, cancellation, session reuse with branch fallback, and the full MCP path: tool call parked, result returned, turn resumed.

Scripts that touch a real Magpie or a real account:

```bash
node test/gateway-tools.mjs <gateway-url> <key>        # two-leg tool round-trip through the gateway
bun test/real-tools-probe.mjs [model]                  # same round-trip against a real CLI (uses quota)
bun test/real-reuse-probe.mjs [model]                  # two turns of one conversation (uses quota)
```

Layout:

| Path | Purpose |
| --- | --- |
| `index.mjs` | Magpie server hook and the loopback MCP endpoint |
| `lib/provider.mjs` | Provider hooks, session pool, request routing, error mapping |
| `lib/chat-wire.mjs` | Chat Completions parsing, prompt rendering, SSE, tool-call encoding |
| `lib/session.mjs` | Codex App Server and ACP session handling |
| `lib/launch.mjs` | Locating and launching CLIs, per-CLI isolation flags |
| `lib/tool-bridge.mjs` | Turning caller tools into an MCP server, parking and resuming turns |
| `lib/mcp-stdio.mjs` | The stdio MCP server the CLI spawns |
| `lib/empty-mcp.mjs` | A stub MCP server that advertises no tools |

## References

- [Magpie plugin docs](https://usemagpie.ai/docs/plugins) for the plugin host and Windows child processes.
- [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host) for the adapter split and [Grok stdio mode](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/grok/permission-modes.md). It is not a runtime dependency.
- Protocol references: [Codex App Server](https://developers.openai.com/blog/codex-as-a-platform), [ACP v1](https://agentclientprotocol.com/protocol/v1/overview), [Antigravity CLI ACP](https://antigravity.google/docs/cli/acp) and [permissions](https://antigravity.google/docs/permissions), [Grok Build agent mode](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md) and its [agent profile tool fields](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md).

## License

[MIT](LICENSE)