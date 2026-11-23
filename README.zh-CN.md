# magpie-local-agents

[![test](https://github.com/ErkundenSie/magpie-local-agents/actions/workflows/test.yml/badge.svg)](https://github.com/ErkundenSie/magpie-local-agents/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/github/license/ErkundenSie/magpie-local-agents)](LICENSE)
[![Magpie](https://img.shields.io/badge/magpie-%E2%89%A50.1.4660-7c3aed)](https://usemagpie.ai)
[![runs on Bun](https://img.shields.io/badge/runs%20on-Bun-f472b6)](https://bun.sh)
[![无依赖](https://img.shields.io/badge/%E4%BE%9D%E8%B5%96-0-brightgreen)](package.json)

在 [Magpie](https://usemagpie.ai) 里直接使用你已经登录的编码 CLI —— **Codex、Claude Code、Antigravity、Grok Build** —— 并把它们作为标准 OpenAI 兼容供应商暴露给 Magpie 网关。

插件把各家 CLI 当作子进程，用它们各自的协议（Codex App Server 或 ACP）驱动，由 CLI 用自己的登录向原厂请求。插件不把订阅包装成 API 流量转发。它唯一会读取的凭据是 Grok 的登录文件，且只用于下面的只读额度查询。

它在 **设置 → 供应商** 里显示为 `Local CLI`，任何 OpenAI 兼容客户端都能经网关调用 `local-cli/<agent>-<模型>`。

[English](README.md)

## 环境要求

- Magpie 0.1.4660 及以上。插件运行在 Magpie 自带的 Bun 上。
- 至少一个受支持的 CLI，并且已经在你自己的终端里登录。

没有 npm 依赖，也没有构建步骤。

## 安装

从 GitHub 安装（推荐）。Magpie 自带的 Bun 会克隆仓库，因此 `git` 需要在 `PATH` 上。之后用 `magpie plugin update` 更新到默认分支的新提交：

```powershell
magpie plugin add github:ErkundenSie/magpie-local-agents
magpie plugin login local-cli   # 把本机 CLI 接入供应商列表，无需密钥
```

`ErkundenSie/magpie-local-agents` 和 `git+https://github.com/ErkundenSie/magpie-local-agents.git` 安装的是同一个包。也可以在 Magpie 的 **设置 → 插件 → 添加插件** 里填上面的地址。要固定在某一版，在后面加上 `#` 和提交号，例如 `github:ErkundenSie/magpie-local-agents#0d572ec`。固定到某一提交后不会再提示更新。本仓库没有发布版本标签，`#v0.10.0` 不是有效地址。

改源码时改成添加本地目录。Magpie 会就地加载，不会复制一份：

```powershell
magpie plugin add 'D:\path\to\magpie-local-agents'
```

修改这份检出后，把插件关闭再打开即可重载。从 GitHub 安装的是 Magpie 插件目录里的一份副本，改另一个克隆不会影响它。

本地工具桥接监听回环端口，默认 `3496`。端口冲突时设置 `MAGPIE_LOCAL_CLI_PORT` 并重启 Magpie。

## 作为供应商使用

模型名形如 `local-cli/<agent>-<原生模型>`。没有原生模型列表的 CLI 只提供 `<agent>-default`，表示交给 CLI 自己的默认模型。

| 模型名 | 说明 |
| --- | --- |
| `local-cli/codex-gpt-6.2-sol` | 按你的账号可用的 Codex 原生模型 |
| `local-cli/codex-default` | 让 Codex 自己选原生模型 |
| `local-cli/claude-default` | Claude Code 的默认模型 |
| `local-cli/antigravity-default` | Antigravity CLI 的默认模型 |
| `local-cli/grok-default` | Grok Build 的默认模型 |

把任何 OpenAI 兼容客户端指向 Magpie 网关（默认 `http://127.0.0.1:3425/v1`），填入网关页面生成的 API key，再选上面的模型名。Chat Completions、Responses 与 Anthropic Messages 之间的转换由 Magpie 负责，因此 Claude Code、Codex 这类客户端也能直接用。

## 网关能力

### 客户端工具原生透传

调用方在请求里声明的 `tools` 会以真正的 MCP 工具出现在 CLI 面前：插件把本地 stdio MCP 服务注入 CLI 的配置或 `session/new`，模型按工具定义直接调用，参数由 CLI 自己序列化。

CLI 调用工具时，插件返回标准 `tool_calls` 并**把该 CLI 回合挂起**；调用方在下一次请求里以同一个 `tool_call_id` 带回 `role: "tool"` 结果后，插件把它交回被阻塞的 MCP 调用，CLI 在同一个回合里继续并流式输出。这与 [`antigravity-bridge`](https://github.com/DylanLIiii/opencode-antigravity-bridge) 的设计一致：支持多轮、并行调用与任意耗时的工具，工具在客户端执行而不是在 CLI 里执行。

### 会话复用

每次请求都会把调用方发来的历史与池中会话「已消费的历史」整体比对，连插件自己返回的助手回复和工具结果一起比对。一致就只把**新增消息**发给 CLI；助手回复被改写、历史被裁剪或换了工具集时新开会话并重放完整历史。同一段历史分叉出的两个后续请求各自得到独立会话，不会互相污染。

最多保留 4 个运行中的会话，空闲 10 分钟后关闭，以减少冷启动和重发历史的开销。

Antigravity 或 Grok 网关完成一轮后，插件会在本机保存原生会话 ID 和历史指纹。重启后，如果客户端发来的历史匹配，插件通过 `session/resume` 接续，只发新增消息。CLI 无法恢复时，插件新开会话并重放客户端提供的历史。Codex 网关线程保持临时会话，不会跨重启恢复。等待工具结果的回合无法跨重启继续。恢复记录不包含消息正文、工具结果或凭据，默认可在 6 小时内使用，存放在 `$XDG_STATE_HOME/magpie-local-agents` 或 `~/.local/state/magpie-local-agents`。可将 `MAGPIE_LOCAL_CLI_AGY_RESUME_DIR` 设为绝对路径来更改位置，或设置 `MAGPIE_LOCAL_CLI_AGY_RESUME_TTL_MS=0` 关闭跨重启恢复。

### 中途换模型与思考等级

同一对话里换模型时，插件在既有会话上切换而不是重开：ACP 走 `session/set_config_option`，Codex 把 `model` 随下一次 `turn/start` 发出。只有 CLI 拒绝该模型时才退回新开会话。

`reasoning_effort`（或 Responses 形状下的 `reasoning.effort`）支持 `minimal`、`low`、`medium`、`high`、`xhigh`。Antigravity 在 agy 提供该档位时也支持 `max`。ACP 通过模型的 `thought_level` 配置项应用，Codex 把 `effort` 随 `turn/start` 发出。原生模型不提供请求的档位时保留 CLI 当前设置。

Antigravity 模型目录显示 agy 为各模型报告的档位。如果同一模型有多个以档位结尾的原生 ID，目录也会提供一个合并别名。原生 ID 仍可调用。别名优先使用 `high`，其次使用已公布的最高档位。请求别名未开放的档位时返回 HTTP 400。

Chat Completions 通过独立的 `reasoning_content` 字段返回 ACP 提供的思考文本和 Codex 提供的摘要。流式调用通过增量帧接收该字段。

已经挂起等工具结果的回合不能改模型或档位，这类请求会改为新开会话。

### 图片

图片以 data URL 放在用户消息或工具结果里：`{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}`。插件把它作为原生内容交给 CLI：ACP 用 `{type:"image", mimeType, data}`，Codex 用内联 data URL。工具结果里的图片随同一次调用返回，CLI 还停在这次调用里时，按原顺序成为 MCP 的 image 块，不会挂到后面的提示词上。

图片不进入文本提示词，代之以 `[image 1: e42704]` 这样的标记，因此历史匹配仍能区分同一位置的两张不同图片。后一轮才出现的图片只随那一轮发送，早先的留在会话里，不再重发。只接受内联 data URL（PNG、JPEG、WebP、GIF，单张 ≤ 8 MiB）；远程图片 URL 会被拒绝而不代抓，插件也不会从磁盘读取图片文件。CLI 未声明支持图片时返回 400，而不是静默丢弃。

### Token 用量

用量随完成的回合返回。Codex 取线程累计计数的回合增量；ACP 读 `session/prompt` 的 `usage`，Grok 也上报在 `_meta.usage`。CLI 提供缓存与推理明细时一并透传。工具调用横跨多个请求时，用量随最后一个完成响应返回一次。流式调用可用 `stream_options.include_usage: true` 在最后一帧读取。CLI 没有上报时省略该字段，不做估算。

### 订阅额度

Magpie 的「用量」页会在 Local CLI 卡片下显示本机 CLI 报告的订阅窗口。可以点击刷新，或运行 `magpie quota refresh local-cli`。刷新只查询勾选了模型的那几家 CLI。Antigravity 的 Gemini 与 Claude/GPT 额度来自同一次读取，所以勾选它的任一模型就会同时显示这两条。读不到勾选名单时，仍查询全部 CLI。

- **Antigravity** 来自 `agy /usage`。卡片上写成 `Gemini (agy)` 和 `Claude/GPT (agy)`，不用 CLI 原来的「Claude and GPT models」，以免看成 Claude 或 GPT 自己的额度。
- **Codex** 来自 app-server 的 `account/rateLimits/read`。
- **Grok** 来自对 Grok 自己计费接口的一次只读 `GET`，用 `grok login` 已存在 `~/.grok/auth.json` 里的 xAI 登录授权。

Grok 这项是插件唯一读取凭据文件的地方。令牌每次查询时读取，只用于这一个发往 `cli-chat-proxy.grok.com` 的请求，不写入、不打印、不缓存、不刷新，也不发往别处。设置 `MAGPIE_LOCAL_CLI_GROK_QUOTA=0` 可完全关闭这项查询。用 `XAI_API_KEY`、`GROK_API_KEY` 或 `GROK_TOKEN` 配置 Grok 时没有订阅窗口，也不会读取任何文件。

Claude Code 的套餐窗口由 ACP 适配器自己上报：`usage_update` 通知的 `_meta["_claude/rateLimit"]` 和 prompt 响应里都带着它。Claude 这部分不读磁盘上的任何文件。所以它的卡片会在本进程里跑过第一轮 Claude 网关对话之后出现，最后一次上报 15 分钟后不再显示。所有窗口都只用于展示，不改变路由。订阅窗口和单次请求的 Token 用量分开上报。

### 错误

CLI 自己报告的配额或限流（usage limit、rate limit、quota、HTTP 429）按 **429** 返回，调用方据此等待；其余失败返回 **502**。

## 隔离

网关调用方是纯文本客户端，不是交互式编码 Agent，因此每个请求都受约束：

| CLI | 网关会话的约束 |
| --- | --- |
| Codex | 只读沙箱、`approvalPolicy: never`、临时线程；关闭 shell 工具、hooks、plugins、apps 与联网搜索；你自己的本地 MCP 服务器逐个替换成「不提供任何工具」的空壳启动器，只配了 `url` 的远程服务器则直接禁用，只保留调用方工具那一个，并以 `default_tools_approval_mode = "approve"` 免去审批往返 |
| Grok Build | 专用 agent profile：内置工具全部剥离，`inheritMcp: false` 不继承全局 MCP/技能/插件；只有调用方声明了工具时才保留 MCP 元工具 |
| Antigravity CLI | `--settings` 注入 `permissions.deny`，默认禁止命令、读写与联网；调用方未声明工具时不列入 `mcp(*)`，并 `toolPermission: strict` |
| Claude Code | `session/new` 的 `_meta` 设 `tools: []` 关闭内置工具；调用方声明工具时不再用 `disallowedTools: ['*']`，以免连它们的 MCP 工具一起禁掉 |

每个 CLI 会话都在独立临时目录里运行，会话关闭时删除。CLI 自身的审批请求一律拒绝，只放行调用方声明的工具。

限制：单次请求 2 MiB、单回合 5 分钟、最多 3 个并发（超出返回 429）、挂起回合最多保留 8 个且 10 分钟内无结果即关闭。

## 支持的 CLI

| CLI | 启动方式 | 准备工作 |
| --- | --- | --- |
| OpenAI Codex | `codex app-server --listen stdio://` | 安装 OpenAI Codex 并在 CLI 或桌面端登录。Windows 还会查找 Microsoft Store 版 Codex Desktop 附带的程序。 |
| Claude Code | `claude-agent-acp`，包装已有的 `claude` | 安装原生 Claude Code 并登录，另外安装 [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp)，例如 `npm install -g @agentclientprotocol/claude-agent-acp`。 |
| Antigravity CLI | `agy acp` | 安装 Google Antigravity CLI 并用 `agy` 登录。Gemini CLI 已停用并由 `agy` 取代，Google 这边用 Antigravity。 |
| Grok Build | `grok agent --no-leader stdio` | 安装 xAI Grok Build 并运行 `grok login`。 |

插件用绝对路径执行程序，绕过登录 shell 和 Magpie 注入 shell profile 的同名函数。

启动程序缺失或需要固定版本时，在项目根目录放 `.local-agents.json`，只写要覆盖的字段，路径请替换成本机实际位置：

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

`claude`、`antigravity` 与 `grok` 同理。Windows 上 `.exe` 直接运行；除 Claude 本体外，标准 npm `.cmd` 启动器会被解析出 JavaScript 入口交给 Node 执行。

Codex 会话固定使用 OpenAI provider，并清除该子进程的自定义推理地址，让 Codex 按原生认证访问官方端点。其他 CLI 使用原生配置；插件会检查常见环境变量与配置文件，发现已知的自定义模型地址时给出提示。认证、企业策略、系统代理与 CLI 自带扩展仍由相应程序处理。

插件不代管 `auth.json`、不刷新 token、不改写各家 CLI 的用户设置。Grok 的登录文件只用于上面的额度查询，从不写回。要还原路由，请在对应的 CLI 或 Magpie 里操作。某个订阅能否在某个 CLI 或 SDK 中使用，由该厂商的账号与产品规则决定。

## 开发验证

```bash
bun test
```

CI 在每次推送和 Pull Request 上运行同一条命令。欢迎贡献，规则见 [CONTRIBUTING.md](CONTRIBUTING.md)：不加依赖、凭据只用于 Grok 的只读额度查询、每个协议改动都要有测试。

测试使用模拟的协议对端，不消耗账号额度。覆盖 ACP 多轮会话、不询问调用方就拒绝内置工具、调用方工具自动放行一次、Codex 只读临时线程、取消、Codex 提前完成的竞态、网关请求校验、流式、取消、会话复用与分支回退，以及 MCP 全链路：工具调用挂起 → 结果回灌 → 同回合续接。

会接触真实 Magpie 或真实账号的脚本：

```bash
node test/gateway-tools.mjs <网关地址> <key>                    # 经网关的两段式工具往返
bun test/real-tools-probe.mjs [模型]                            # 对真实 CLI 跑工具往返（消耗额度）
bun test/real-reuse-probe.mjs [模型]                            # 同一对话的两轮复用（消耗额度）
```

目录说明：

| 路径 | 作用 |
| --- | --- |
| `index.mjs` | Magpie server 钩子与回环 MCP 端点 |
| `lib/provider.mjs` | 供应商钩子、会话池、请求路由、错误映射 |
| `lib/chat-wire.mjs` | Chat Completions 解析、提示词渲染、SSE、工具调用编码 |
| `lib/session.mjs` | Codex App Server 与 ACP 会话处理 |
| `lib/launch.mjs` | 定位并启动 CLI，各 CLI 的隔离参数 |
| `lib/tool-bridge.mjs` | 把调用方工具变成 MCP 服务，挂起与续接回合 |
| `lib/mcp-stdio.mjs` | CLI 启动的 stdio MCP 服务 |
| `lib/empty-mcp.mjs` | 不提供任何工具的空壳 MCP 服务 |

## 参考

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)：插件宿主与 Windows 子进程接入。
- [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host)的适配器划分与 [Grok stdio 模式](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/grok/permission-modes.md)。它不是运行依赖。
- 协议参考：[Codex App Server](https://developers.openai.com/blog/codex-as-a-platform)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)、[Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)与[权限](https://antigravity.google/docs/permissions)、[Grok Build Agent 模式](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)及其 [agent profile 工具字段](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)。

## 许可

[MIT](LICENSE)
