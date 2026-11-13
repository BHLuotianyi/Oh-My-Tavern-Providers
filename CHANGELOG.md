# 更新日志

## 未发布

### 新增

- **火山方舟 Coding Plan / Agent Plan**：新增两个服务商（`/api/coding/v3`、`/api/plan/v3`），内置官方文档列出的模型和 `ark-code-latest`。方舟规定套餐只能在 AI 编程 / Agent 工具中使用，在 SillyTavern 中使用可能导致订阅停用或封号；登录行上会显示这条警告。
- **只发送 max_tokens 开关**：上面两个服务商的登录行新增此开关，默认开启。请求同时带 `max_tokens` 和 `max_completion_tokens` 时（如 MVU 额外模型解析），网关去掉 `max_completion_tokens`，避免方舟返回 400 "cannot be set at the same time"。其他服务商的请求不受影响。

### 修复

- **原生路由识别不到 SillyTavern 已保存的密钥**：SillyTavern 1.19 下凭据探测全部失效，原生模型被标为“无凭据”或改走网关。现直接读取 SillyTavern 的密钥状态。
- **订阅登录过期后无法续期**：此前只有 Claude 订阅和两个 Google 登录会自动刷新令牌，ChatGPT Plus/Pro、Kimi Code、GitLab Duo、Factory 等过期后只能重新登录。现按各服务商的登录策略统一刷新；刷新失败时网关直接返回 401 并给出原因，不再带着过期令牌请求上游。
- **密钥外泄风险**：
  - 刷新或导入的目录不再能把形如 `127.xxx.域名` 的地址当作本机地址，借此把 SillyTavern 中保存的密钥发往外部。
  - 修改服务商的接口地址（换到其他域名）后，旧密钥会被清除，需重新填写；SillyTavern 中保存的密钥和环境变量密钥只发往目录登记的原始域名。
- **TauriTavern 伴随程序**：收到 `GET //` 一类请求时整个进程崩溃，现返回 400。
- **Claude 思考模式**：开启推理后 `max_tokens` 可能超过模型输出上限，导致 Anthropic 返回 400；现按模型上限截断。
- **用量统计**：OpenAI 兼容服务商的流式对话此前不计用量，现请求上游返回用量（不支持时自动去掉该参数重试）。转译型服务商的流式响应带上真实模型名。
- **代理**：代理隧道内 TLS 握手卡住时请求不再永久挂起；读取系统代理不再阻塞服务器。
- **xAI Grok OAuth**：该登录依赖 OMTP 未内置的服务商脚本，现标为不可登录，不再在授权后才失败。
- **界面**：
  - 模型中心里角色绑定状态始终显示“未绑定”。
  - `/switch` 选择器中用输入法确认候选词时按 Enter 会直接切换模型。
  - 禁用扩展后 `/switch` 选择器和登录轮询仍在运行。
  - Connection Profiles 视图内搜索始终无结果。
  - 剩余的英文提示改为可翻译。
- 管理请求增加超时，伴随程序不可达时不再卡住模型切换和面板加载。

### 变更

- 需要 Node.js 18.17 或更高版本。
- 网关先校验令牌再读取请求体；统计面板只接受本机地址访问。
- 大型服务商（如 OpenRouter）的模型列表分批渲染，搜索与切换更快。
- 发布包不再包含 `tests/`、`docs/`、`tools/` 等开发文件，目录文件以压缩格式打包。

## 2.2.1

### 新增

- **Gemini 4 Hydrogen**（Google Antigravity）：在线模型列表把 `gemini-4-hydrogen-low/medium/high/xhigh` 合并为一个 `gemini-4-hydrogen`，模型详情列出这四档；推理强度 **max** 对应 `xhigh`，其余按同名档位发送，未指定时用 `low`。Antigravity 的其他分档模型（如 Claude、GPT-OSS）也改为按在线列表中实际存在的档位发送。

### 变更

- 性格数据更新为 AA-PersonalityBench 2026-11-12 的结果（43 个模型，新增 Claude Fable 5.2）。

## 2.2.0

### 新增

- **手机版适配**：窄屏（不超过 760px）上面板铺满屏幕，服务商改为横向滑动的一行，点击模型后详情覆盖在列表上并提供 **返回列表**；触屏上长按快捷槽位可清空；打开面板不再自动弹出键盘；输入框字号不小于 16px，避免 iOS 聚焦时页面放大；`/switch` 选择器移到屏幕顶部，不被键盘遮挡；顶栏放不下的 token 徽章在窄屏上隐藏。
- **TauriTavern 支持**：
  - **伴随服务**：TauriTavern 无法运行服务端插件，改用 `node server-plugin/standalone.mjs` 在 SillyTavern 之外运行服务端插件的全部功能（网关、登录、用量与统计、目录刷新、OMP 导入）。在 TauriTavern 的 OMTP 设置 **伴随服务（TauriTavern）** 中填写它打印的地址和令牌即可使用；用 `--host 0.0.0.0` 启动可供局域网内的手机使用，`--data SillyTavern/data` 可与 SillyTavern 共用密钥。用法见 README 的 TauriTavern 一节。
  - 未连接伴随服务时只能使用原生模型，网关状态显示“无网关”并说明如何启动伴随服务；伴随服务连不上时提示检查地址与令牌。
  - OAuth 登录直接用系统浏览器打开授权页。
  - TauriTavern 去掉了对话补全以外的接口，文本补全、NovelAI、AI Horde 的模型现标为不可用，不再在切换时等待超时。
  - 开启 TauriTavern 的面板运行时后，未选中的对话补全来源的表单不在页面中，其模型不再被误判为不可用；切换时模型不存在则恢复原来的连接。
  - 恢复连接时保留 TauriTavern Custom 连接的协议（`custom_api_format`，如 Claude Messages）。

### 变更

- 服务端插件的实现移到 `server-plugin/lib/plugin.mjs`，`index.mjs` 只负责接入 SillyTavern，行为不变。更新时照常整个重新复制 `server-plugin` 目录，不要只替换 `index.mjs`。

### 修复

- 面板与 `/switch` 选择器的遮罩改为按视口高度定位。SillyTavern 在手机布局下给 `<html>` 加了 transform，此前遮罩高度为 0，面板在手机上无法正常显示。
- 原生切换在改动接口或来源后失败时，恢复切换前的连接，不再停在半切换状态。

## 2.1.2

### 修复

- **出站代理**：使用 Clash 等代理时，登录、密钥校验和网关转发可能绕过代理直连，表现为 `UND_ERR_CONNECT_TIMEOUT`（例如 Google Antigravity 登录时连接 `oauth2.googleapis.com` 超时）。所有服务商共用这一出站通道，均受影响，现已一并修复：
  - 系统代理不再只在 SillyTavern 启动时读取一次，而是运行中每 10 秒刷新。启动 SillyTavern 后再打开 Clash 的“系统代理”也会生效，无需重启。
  - 支持 SOCKS5 代理（`socks5://`、`socks5h://`、`socks://`，含用户名密码）。此前 SillyTavern `requestProxy` 设置的 `all_proxy=socks5://…`、Windows 代理设置里的 `socks=` 都会被忽略，并导致不再读取系统代理。
  - 代理与直连都失败时，错误信息同时给出代理的失败原因，便于排查。
- 说明：Clash TUN 模式在系统层面接管流量，与插件无关。若开启 TUN 后仍直连超时，说明 TUN 未接管 `node.exe` 或其 DNS；可改为打开系统代理，或以 `HTTPS_PROXY=http://127.0.0.1:<端口>` 启动 SillyTavern。

## 2.1.1

### 修复

- **Claude 订阅（OAuth）**：带系统提示词的请求（SillyTavern 的每条对话都带）被 Anthropic 以 429 `rate_limit_error` "Error" 拒绝。现按 Claude Code 的格式发送系统提示：计费认证块（`x-anthropic-billing-header`，含版本指纹与请求体 `cch` 校验）、身份块、用户提示词。
