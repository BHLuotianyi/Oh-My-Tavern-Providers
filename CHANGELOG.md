# 更新日志

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
