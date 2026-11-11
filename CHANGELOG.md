# 更新日志

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
