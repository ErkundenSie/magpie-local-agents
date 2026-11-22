# magpie-local-agents

在 [Magpie](https://usemagpie.ai) 里直接使用你已经登录的编码 CLI —— **Codex、Claude Code、Gemini CLI、Antigravity、Grok Build** —— 并把它们作为标准 OpenAI 兼容供应商暴露给 Magpie 网关。

插件把各家 CLI 当作子进程，用它们各自的协议（Codex App Server 或 ACP）驱动，由 CLI 用自己的登录向原厂请求。插件不读取、不保存、不刷新任何订阅 token，也不把订阅包装成 API 流量转发。

- **页面插件**：在 Magpie 左侧选择 Agent 和工作区，直接对话。
- **供应商**：在 **设置 → 供应商** 里显示为 `Local CLI`，任何 OpenAI 兼容客户端都能经网关调用 `local-cli/<agent>-<模型>`。

[English](README.md)

## 环境要求

- Magpie 0.1.4660 及以上。插件运行在 Magpie 自带的 Bun 上。
- 至少一个受支持的 CLI，并且已经在你自己的终端里登录。

没有 npm 依赖，也没有构建步骤。

## 安装

```powershell
magpie plugin add 'D:\path\to\magpie-local-agents'
magpie plugin login local-cli   # 把本机 CLI 接入供应商列表，无需密钥
```

也可以在 Magpie 的 **设置 → 插件 → 添加插件** 里填项目目录的绝对路径。修改源码后，把插件关闭再打开即可重载。

页面与网关共用回环端口，默认 `3496`。端口冲突时设置 `MAGPIE_LOCAL_CLI_PORT` 并重启 Magpie。

## 作为供应商使用

模型名形如 `local-cli/<agent>-<原生模型>`。没有原生模型列表的 CLI 只提供 `<agent>-default`，表示交给 CLI 自己的默认模型。

| 模型名 | 说明 |
| --- | --- |
| `local-cli/codex-gpt-6.2-sol` | 按你的账号可用的 Codex 原生模型 |
| `local-cli/codex-default` | 让 Codex 自己选原生模型 |
| `local-cli/claude-default` | Claude Code 的默认模型 |
| `local-cli/gemini-default` | Gemini CLI 的默认模型 |
| `local-cli/antigravity-default` | Antigravity CLI 的默认模型 |
| `local-cli/grok-default` | Grok Build 的默认模型 |

把任何 OpenAI 兼容客户端指向 Magpie 网关（默认 `http://127.0.0.1:3425/v1`），填入网关页面生成的 API key，再选上面的模型名。Chat Completions、Responses 与 Anthropic Messages 之间的转换由 Magpie 负责，因此 Claude Code、Codex 这类客户端也能直接用。

## 网关能力

### 客户端工具原生透传

调用方在请求里声明的 `tools` 会以真正的 MCP 工具出现在 CLI 面前：插件把本地 stdio MCP 服务注入 CLI 的配置或 `session/new`，模型按工具定义直接调用，参数由 CLI 自己序列化。

CLI 调用工具时，插件返回标准 `tool_calls` 并**把该 CLI 回合挂起**；调用方在下一次请求里以同一个 `tool_call_id` 带回 `role: "tool"` 结果后，插件把它交回被阻塞的 MCP 调用，CLI 在同一个回合里继续并流式输出。这与 [`antigravity-bridge`](https://github.com/DylanLIiii/opencode-antigravity-bridge) 的设计一致：支持多轮、并行调用与任意耗时的工具，工具在客户端执行而不是在 CLI 里执行。

### 会话复用

每次请求都会把调用方发来的历史与池中会话「已消费的历史」整体比对，连插件自己返回的助手回复和工具结果一起比对。一致就只把**新增消息**发给 CLI；助手回复被改写、历史被裁剪或换了工具集时新开会话并重放完整历史。同一段历史分叉出的两个后续请求各自得到独立会话，不会互相污染。

最多保留 4 个会话，空闲 10 分钟关闭。省下每轮冷启动和重发整段历史的开销。

### 中途换模型与思考等级

同一对话里换模型时，插件在既有会话上切换而不是重开：ACP 走 `session/set_config_option`，Codex 把 `model` 随下一次 `turn/start` 发出。只有 CLI 拒绝该模型时才退回新开会话。

`reasoning_effort`（或 Responses 形状下的 `reasoning.effort`）取 `minimal`、`low`、`medium`、`high`、`xhigh`。ACP 通过 `thought_level` 配置项应用，Codex 把 `effort` 随 `turn/start` 发出。CLI 不提供该档位时保留它自己的默认值，不会因此让整个请求失败。

已经挂起等工具结果的回合不能改模型或档位，这类请求会改为新开会话。

### 图片

图片以 data URL 传入：`{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}`。插件把它作为原生内容交给 CLI：ACP 用 `{type:"image", mimeType, data}`，Codex 用内联 data URL。

图片不进入文本提示词，代之以 `[image 1: e42704]` 这样的标记，因此历史匹配仍能区分同一位置的两张不同图片。只接受内联 data URL（PNG、JPEG、WebP、GIF，单张 ≤ 8 MiB）；远程图片 URL 会被拒绝而不代抓——本机不能把调用方的 URL 变成自己的请求，而且 Codex 本身也拒绝远程图片。CLI 未声明支持图片时返回 400，而不是静默丢弃。

### Token 用量

用量随完成的回合返回。Codex 取线程累计计数的回合增量；ACP 读 `session/prompt` 的 `usage`，Grok 也上报在 `_meta.usage`。CLI 提供缓存与推理明细时一并透传。工具调用横跨多个请求时，用量随最后一个完成响应返回一次。流式调用可用 `stream_options.include_usage: true` 在最后一帧读取。CLI 没有上报时省略该字段，不做估算。

### 错误

CLI 自己报告的配额或限流（usage limit、rate limit、quota、HTTP 429）按 **429** 返回，调用方据此等待；其余失败返回 **502**。

## 隔离

网关调用方是纯文本客户端，不是交互式编码 Agent，因此每个请求都受约束：

| CLI | 网关会话的约束 |
| --- | --- |
| Codex | 只读沙箱、`approvalPolicy: never`、临时线程；关闭 shell 工具、hooks、plugins、apps 与联网搜索；你自己的 MCP 服务器逐个替换成「不提供任何工具」的空壳启动器，只保留调用方工具那一个，并以 `default_tools_approval_mode = "approve"` 免去审批往返 |
| Grok Build | 专用 agent profile：内置工具全部剥离，`inheritMcp: false` 不继承全局 MCP/技能/插件；只有调用方声明了工具时才保留 MCP 元工具 |
| Antigravity CLI | `--settings` 注入 `permissions.deny`，默认禁止命令、读写与联网；调用方未声明工具时不列入 `mcp(*)`，并 `toolPermission: strict` |
| Gemini CLI | `--admin-policy` 注入默认全禁的策略，调用方声明工具时用更高优先级的 `mcp_*` 放行 |
| Claude Code | `session/new` 的 `_meta` 设 `tools: []` 关闭内置工具；调用方声明工具时不再用 `disallowedTools: ['*']`，以免连它们的 MCP 工具一起禁掉 |

每个 CLI 会话都在独立临时目录里运行，会话关闭时删除。CLI 自身的审批请求一律拒绝，只放行调用方声明的工具。

限制：单次请求 2 MiB、单回合 5 分钟、最多 3 个并发（超出返回 429）、挂起回合最多保留 8 个且 10 分钟内无结果即关闭。

## 支持的 CLI

| 页面选项 | 启动方式 | 准备工作 |
| --- | --- | --- |
| OpenAI Codex | `codex app-server --listen stdio://` | 安装 OpenAI Codex 并在 CLI 或桌面端登录。Windows 还会查找 Microsoft Store 版 Codex Desktop 附带的程序。 |
| Claude Code | `claude-agent-acp`，包装已有的 `claude` | 安装原生 Claude Code 并登录，另外安装 [Claude Agent ACP](https://github.com/agentclientprotocol/claude-agent-acp)，例如 `npm install -g @agentclientprotocol/claude-agent-acp`。 |
| Gemini CLI | `gemini --acp` | 安装支持 `--acp` 的 Gemini CLI。Google One 和免费个人用户可改用 Antigravity CLI。 |
| Antigravity CLI | `agy acp` | 安装 Google Antigravity CLI 并用 `agy` 登录。 |
| Grok Build | `grok agent --no-leader stdio` | 安装 xAI Grok Build 并运行 `grok login`。 |

界面的「可用」只表示找到了启动程序；真正的登录状态由 CLI 在启动会话时判断。插件用绝对路径执行程序、不经过登录 shell，因此会跳过 Magpie 注入 shell profile 的同名函数。

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

`gemini` 与 `antigravity` 同理。Windows 上 `.exe` 直接运行；除 Claude 本体外，标准 npm `.cmd` 启动器会被解析出 JavaScript 入口交给 Node 执行。

## 页面插件

同一页面内，同一个 Agent 在同一工作区复用原生会话，支持实时文本、工具状态、单次审批与停止。工具与沙箱策略由各 CLI 执行。重置页面、换 Agent 或换工作区会启动新会话；页面连接关闭后结束子进程。页面尚未实现历史恢复、模型选择或原生提问表单。

Codex 会话固定使用 OpenAI provider，并清除该子进程的自定义推理地址，让 Codex 按原生认证访问官方端点。其他 CLI 使用原生配置；插件会检查常见环境变量与配置文件，发现已知的自定义模型地址时给出提示。认证、企业策略、系统代理与 CLI 自带扩展仍由相应程序处理。

插件不读取或代管 `auth.json`、不刷新 token、不改写各家 CLI 的用户设置。要还原路由，请在对应的 CLI 或 Magpie 里操作。某个订阅能否在某个 CLI 或 SDK 中使用，由该厂商的账号与产品规则决定。

## 开发验证

```bash
bun test
```

测试使用模拟的协议对端，不消耗账号额度。覆盖 ACP 多轮会话、单次授权、取消、Codex 提前完成的竞态、网关请求校验、流式、取消、会话复用与分支回退，以及 MCP 全链路：工具调用挂起 → 结果回灌 → 同回合续接。

会接触真实 Magpie 或真实账号的脚本：

```bash
node test/page-contract.mjs <magpie地址> <web key>              # 页面文档、引导文件与 WebSocket 握手
node test/browser-check.mjs <magpie地址> <web key> <chrome路径>  # 页面在 Magpie 沙箱框架内到达 ready
node test/gateway-tools.mjs <网关地址> <key>                    # 经网关的两段式工具往返
bun test/real-tools-probe.mjs [模型]                            # 对真实 CLI 跑工具往返（消耗额度）
bun test/real-reuse-probe.mjs <项目路径> [模型]                  # 同一对话的两轮复用（消耗额度）
```

目录说明：

| 路径 | 作用 |
| --- | --- |
| `index.mjs` | Magpie server 钩子：页面服务、引导文件、WebSocket、MCP 端点 |
| `lib/provider.mjs` | 供应商钩子、会话池、请求路由、错误映射 |
| `lib/chat-wire.mjs` | Chat Completions 解析、提示词渲染、SSE、工具调用编码 |
| `lib/session.mjs` | Codex App Server 与 ACP 会话处理 |
| `lib/launch.mjs` | 定位并启动 CLI，各 CLI 的隔离参数 |
| `lib/tool-bridge.mjs` | 把调用方工具变成 MCP 服务，挂起与续接回合 |
| `lib/mcp-stdio.mjs` | CLI 启动的 stdio MCP 服务 |
| `lib/empty-mcp.mjs` | 不提供任何工具的空壳 MCP 服务 |
| `page/`、`app/` | 页面插件引导与界面 |

## 参考

- [Magpie 插件文档](https://usemagpie.ai/docs/plugins)与 [Agent Console](https://github.com/magpie-community/plugins/tree/main/packages/agent-console)：页面插件、宿主与 Windows 子进程接入。
- [BytePioneer-AI/codex-host](https://github.com/BytePioneer-AI/codex-host)的适配器划分与 [Grok stdio 模式](https://github.com/BytePioneer-AI/codex-host/blob/main/docs/harnesses/grok/permission-modes.md)。它不是运行依赖。
- 协议参考：[Codex App Server](https://developers.openai.com/blog/codex-as-a-platform)、[ACP v1](https://agentclientprotocol.com/protocol/v1/overview)、[Gemini CLI ACP](https://geminicli.com/docs/cli/acp-mode)与[策略引擎](https://geminicli.com/docs/reference/policy-engine)、[Antigravity CLI ACP](https://antigravity.google/docs/cli/acp)与[权限](https://antigravity.google/docs/permissions)、[Grok Build Agent 模式](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md)及其 [agent profile 工具字段](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/README.md)。

## 许可

[MIT](LICENSE)
