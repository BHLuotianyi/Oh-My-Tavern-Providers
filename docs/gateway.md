[English](./gateway.en.md) | 简体中文 | [返回 README](../README.md)

# 服务端插件参考

服务端插件（仓库中的 `server-plugin/`，安装到 `SillyTavern/plugins/omtp/`）在 SillyTavern 进程内运行，提供两样东西：

- **管理接口**：挂载在 SillyTavern 的 `/api/plugins/omtp/*` 下，供 OMTP 前端读写配置、密钥与登录状态。
- **网关**：一个独立的 OpenAI 兼容 HTTP 服务，默认地址 `http://127.0.0.1:4100/v1`。SillyTavern 以 Custom OpenAI 来源连接它，网关再按目录选择协议适配器，把请求转发给上游。

插件的数据保存在 `<SillyTavern 数据目录>/omtp/`，默认即 `SillyTavern/data/omtp/`。

## 目录

- [网关](#网关)
- [管理接口](#管理接口)
- [协议适配器](#协议适配器)
- [凭据](#凭据)
- [OAuth 登录](#oauth-登录)
- [请求身份头](#请求身份头)
- [额度查询](#额度查询)
- [用量统计与计费](#用量统计与计费)
- [在线模型缓存](#在线模型缓存)
- [出站代理](#出站代理)
- [数据文件](#数据文件)
- [环境变量](#环境变量)
- [安全边界](#安全边界)
- [伴随服务（TauriTavern）](#伴随服务tauritavern)

## 网关

- **监听地址**：只绑定 `127.0.0.1`。端口默认 4100，可在设置中修改。
- **端口冲突**：端口被占用时依次尝试 4101 … 4110，成功后把新端口写回配置。若占用端口的是另一个 OMTP 网关，且它接受本实例的令牌（或双方都关闭了鉴权），则直接复用它；它拒绝本实例的令牌时跳过该端口。
- **鉴权**：默认要求 `Authorization: Bearer <令牌>`，用常量时间比较。令牌在首次启动时生成，保存在 `gateway-token`（`0600`），前端通过 `GET /api/plugins/omtp/gateway/token` 获取。
- **关闭鉴权**：`requireAuth: false` 时不检查令牌，但 `/v1/*` 只接受 Host 为 `localhost`、`127.x` 或 `::1` 的请求，其余返回 403 `host_not_allowed`。

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/health` | 无 | 返回 `{ ok, service: 'omtp-gateway', version, catalogVersion }` |
| `GET` | `/v1/models` | 令牌 | 有可用凭据（或无需凭据）的 `服务商/模型` 列表 |
| `POST` | `/v1/chat/completions` | 令牌 | OpenAI 兼容的聊天补全，支持流式 SSE 和非流式 JSON |

`/v1/chat/completions` 的 `model` 必须是 `服务商/模型`。请求头 `X-OMTP-Chat`（SillyTavern 以百分号编码发送的聊天 ID）用于按聊天统计用量。客户端断开时，网关会中止上游请求，已产生的用量仍会记账。

## 管理接口

所有路由挂载在 `/api/plugins/omtp` 下，沿用 SillyTavern 的登录与 CSRF 校验，另外要求请求头 `x-omtp-client: omtp-web`（见[安全边界](#安全边界)）。

| 分类 | 路由 | 说明 |
|---|---|---|
| 状态 | `GET /status` | 插件版本、网关状态与端口、目录统计 |
| 网关 | `GET /gateway/token` | 读取网关令牌 |
| | `POST /gateway/restart` | 重启网关 |
| | `GET /config`、`POST /config` | 读取或修改 `autoStart`、`port`、`requireAuth`。把 `requireAuth` 设为 `false` 必须同时提交 `confirmInsecure: true` |
| 代理 | `GET /proxy`、`POST /proxy` | 读取或修改出站代理：`mode` 为 `system`、`manual` 或 `direct`，`manual` 需要 `url`。返回当前生效的代理及其来源 |
| | `POST /proxy/test` | 分别经当前代理和直连访问几个登录要用到的站点，返回每一路的状态码、耗时或错误 |
| 目录 | `GET /catalog` | 合并后的完整目录 |
| | `POST /catalog/refresh` | 从请求体中的 `url`（或默认上游）刷新目录 |
| | `POST /import/omp` | 从本地 OMP 导入目录覆盖层；`credentials: true` 且 `confirm: true` 时同时导入凭据 |
| 服务商 | `GET /providers` | 各服务商的可用性、凭据来源、密钥末四位、登录方式、模型数 |
| | `POST /providers/:id/key`、`DELETE /providers/:id/key` | 保存或清除 API 密钥 |
| | `POST /providers/:id/config`、`DELETE /providers/:id/config` | 新建、修改或删除服务商配置（`label`、`adapter`、`baseUrl`、`headers`、`extraConfig`、`custom`、`models`、`userAgentSpoof`、`singleMaxTokens`） |
| | `POST /providers/:id/test` | 用真实适配器请求上游，检查连通性 |
| | `GET /providers/:id/models` | 获取在线模型列表，`?refresh=true` 跳过缓存。见[在线模型缓存](#在线模型缓存) |
| 登录 | `POST /providers/:id/login` | 开始登录会话 |
| | `GET /providers/:id/login/:session` | 查询会话状态：`pending`、`done`、`error` |
| | `POST /providers/:id/login/:session/code` | 提交粘贴的回调 URL 或授权码 |
| | `DELETE /providers/:id/login/:session` | 取消会话 |
| | `POST /providers/:id/logout` | 退出登录并清除凭据 |
| 用量 | `GET /usage` | 各订阅服务商的额度，`?refresh=true` 跳过缓存 |
| | `GET /stats` | token 与费用统计；`?chat=` 按聊天，`?since=` 按起始时间 |
| | `GET /stats/server`、`GET /stats/server/status` | 启动（或复用）统计页面，或查询其状态 |

`providers.json` 或 `master.key` 无法解密时，相关路由返回 409，不会覆盖已有数据。

## 协议适配器

| 适配器 | 上游协议 | 说明 |
|---|---|---|
| `openai` | OpenAI Chat Completions | 直接转发，保留流式 SSE、工具调用与 `reasoning_content` |
| `anthropic` | Anthropic Messages | 转换系统提示词、工具定义与思考块；支持 Claude 订阅 OAuth |
| `google` | Gemini API | 保留缓存命中与思考 token 计数 |
| `google-vertex` | Vertex AI | 服务账号 JSON 或 ADC 令牌，支持区域端点 |
| `antigravity` | Cloud Code Assist（`v1internal`） | Google Antigravity 与 Gemini CLI 的 OAuth 会话，多端点故障转移 |
| `responses` | OpenAI Responses API | 把 Chat Completions 转换为 `/responses`，保留推理与缓存计数 |
| `azure-responses` | Azure OpenAI Responses | Azure 部署路径、`api-key` 头、`api-version` |
| `bedrock` | Amazon Bedrock Converse | AWS 签名或 Bearer 令牌，把 Converse 响应转换为 OpenAI SSE |
| `ollama` | Ollama | 本地 `/api/chat` 与 `/v1` 接口，无需密钥 |

只支持专有客户端协议、没有公开无头登录方式的服务商，以及搜索类非聊天服务，不能经网关转发。它们仍在面板中列出，并注明原因（目录字段 `unsupportedReason`）。

## 凭据

查找某个服务商的凭据时，按以下顺序取第一个可用值：

1. OMTP 密钥库 `providers.json`（AES-256-GCM 加密，主密钥 `master.key`）
2. SillyTavern 默认用户的 `secrets.json`（如 `api_key_openai`、`api_key_claude`）
3. 目录为该服务商声明的环境变量（如 `OPENAI_API_KEY`）

一些登录方式会把多个服务商的凭据写进同一条记录（目录字段 `authLogin.storeAs`）。

## OAuth 登录

目录中每个服务商的 `authLogin` 描述登录方式：

| 类型 | 流程 |
|---|---|
| `oauth-code` | 授权码，可带 PKCE。插件在本机回环地址监听回调；也可以粘贴回调 URL |
| `device-code` | RFC 8628 设备码，插件在后台轮询 |
| `custom` | 服务商专用流程，目前实现了 `openai-codex-device` 与 `kilo` |

回调监听由 `authLogin.callback` 控制：

| 字段 | 行为 |
|---|---|
| `redirectUri` | 声明的值优先。`http://` 回环地址按其 host、端口、路径监听；`zcode://`、`vscode://` 等自定义协议无法在本机接收，改为手动粘贴 |
| `manualOnly` | 不监听，只返回授权链接与粘贴说明 |
| `nativeScheme` | 同 `manualOnly`（插件没有系统协议处理器） |
| `portFallback` | 端口被占用时改为手动粘贴，并在 `instructions` 中说明原因 |

`localhost` 回调会同时监听 `127.0.0.1` 与 `::1`。回调请求必须带本次会话的 `state`（目录声明 `state: none` 的服务商除外，如 OpenRouter）；不带或不匹配的请求返回 400，不改变会话、不释放端口。同一授权码的重复回调共用同一次换取。没有 `code` 的请求（代理或安全软件的探测）不会结束会话。

授权码换取令牌后，可以运行 `authLogin.afterExchange` 指定的钩子补充凭据：

| 钩子 | 作用 |
|---|---|
| `anthropic-identity` | 账号与组织信息 |
| `openai-codex-profile` | Codex 账号信息 |
| `google-gemini-cli-project`、`google-antigravity-project` | 获取 Google Cloud 项目 ID |
| `zai-mint-key` | 用短期令牌换取长期 API 密钥 |
| `muse-code-key` | 换取 API 密钥 |
| `factory-droid-region` | 确定区域端点 |
| `gitlab-duo-clear-cache` | 清除旧的直连缓存 |

未知钩子只记录日志，不影响登录结果。

### OAuth 客户端凭据

已安装应用的 `client_id` / `client_secret` 是公开标识（RFC 8252 §8.1），目录默认内置这些公开值，让订阅登录开箱可用。唯一的例外是 `google-gemini-cli`：它的端点只接受官方应用，目录中只保留环境变量名，需要在本机配置（见 `server-plugin/lib/catalog-normalize.mjs` 的 `LOCAL_ONLY_CLIENTS`）。任何服务商的值都可以在本机覆盖：

- 环境变量 `OMTP_<服务商>_CLIENT_ID`、`OMTP_<服务商>_CLIENT_SECRET`，服务商 ID 转为大写并把非字母数字替换为 `_`，如 `OMTP_GOOGLE_ANTIGRAVITY_CLIENT_ID`；
- 或 `oauth-clients.json`：

  ```json
  {
    "google-antigravity": { "clientId": "…", "clientSecret": "…" },
    "openai-codex": { "clientId": "…" }
  }
  ```

环境变量优先。用户的令牌只保存在加密的密钥库中。

## 请求身份头

部分上游需要会话标识与客户端身份。目录中服务商的 `requestHeaders` 声明策略，网关负责填写：

| 字段 | 作用 |
|---|---|
| `sessionHeader`、`sessionPrefix` | 会话头的名称与前缀。值为 `HMAC-SHA256(install-id, 服务商 + 聊天 ID)` 派生的 24 位 base62：同一聊天、同一服务商不变，重启后不变，且不暴露聊天文件名 |
| `sessionForce` | 为真时，会话头覆盖用户配置中的同名头 |
| `spoofUserAgent` | 登录面板「伪装 User-Agent」开关使用的值，默认开启；关闭后转发 SillyTavern 自己的 User-Agent |

没有聊天上下文的请求（额度查询、模型发现）使用 `install-id` 本身。目前声明该策略的服务商：`opencode-go`、`opencode-zen`（`x-opencode-session`）。

## 额度查询

`GET /usage` 对已有凭据的服务商调用其额度接口，结果按凭据缓存 60 秒：

| 服务商 | 上游接口 | 返回内容 |
|---|---|---|
| Google Antigravity、Gemini CLI | `POST /v1internal:retrieveUserQuotaSummary` | 按模型族的周度与 5 小时窗口 |
| OpenAI Codex | `GET chatgpt.com/backend-api/wham/usage` | 主次窗口与套餐名 |
| Anthropic（Claude Pro / Max） | `GET api.anthropic.com/api/oauth/usage` | 5 小时与 7 天窗口、额外用量余额 |
| Z.AI、智谱 Coding Plan | `GET api.z.ai/api/monitor/usage/quota/limit` | token、时间与额度窗口 |
| Kimi Code | `GET api.kimi.com/coding/v1/usages` | 各周期窗口 |
| MiniMax（国际 / 国内） | `GET {api.minimax.io, api.minimaxi.com}/v1/token_plan/remains` | 按模型的 5 小时与周度剩余 |
| xAI | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | 周度额度、月度包含额度、按需计费 |
| GitHub Copilot | `GET api.github.com/copilot_internal/user` | Premium、Chat、Completions 配额与重置时间 |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` | 5 小时、周度、月度窗口 |
| Cursor | `GET api2.cursor.sh/auth/usage` | 账单周期内的请求额度 |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` | 5 小时与周度窗口、积分 |
| ClinePass | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` | 5 小时、周度、月度窗口 |
| Synthetic | `GET api.synthetic.new/v2/quotas` | 5 小时与周度窗口 |
| Umans | `GET api.code.umans.ai/v1/usage` | 请求窗口与突发上限 |
| Charm Hyper | `GET hyper.charm.land/v1/credits` | 积分余额 |
| DeepSeek | `GET api.deepseek.com/user/balance` | 各币种余额 |

完整列表以 `server-plugin/lib/usage.mjs` 中的 `ADAPTERS` 为准。

## 用量统计与计费

网关从每个响应（流式或非流式）中读取最后一个 `usage` 对象，按服务商、模型、日期和聊天累计到 `usage-stats.json`。token 分为不重叠的几类：

| 类别 | 来源 |
|---|---|
| 输入 | `prompt_tokens` 减去缓存读写部分 |
| 缓存读、缓存写 | `prompt_tokens_details` 或各协议的对应字段 |
| 输出 | `completion_tokens`，**包含**推理 token |
| 推理 | `completion_tokens_details.reasoning_tokens`，是输出的一部分 |

所有适配器都按这个口径输出 `usage`：例如 Gemini 的 `candidatesTokenCount` 不含思考 token，适配器会把 `thoughtsTokenCount` 加进 `completion_tokens`。

费用按目录的每百万 token 单价估算：

```
输入 × 输入单价
+ 缓存读 × 缓存读单价 + 缓存写 × 缓存写单价
+ (输出 − 推理) × 输出单价
+ 推理 × 推理单价
```

单价为 0 或缺失时：缓存读写按输入单价计，推理按输出单价计。在线发现、目录中没有单价的模型，使用该服务商默认模型的单价，没有时取已定价模型输出单价的中位数。

`/omtp stats` 打开的统计页面由 `GET /stats/server` 启动，只监听 `127.0.0.1`，默认端口 3847（被占用时换用其他端口），30 分钟无请求后自动关闭。

## 在线模型缓存

`GET /providers/:id/models` 调用服务商的模型列表接口（适配器有 `listModels` 时用它，否则用服务商的 `/models`）。

- **新鲜期**：成功结果在 5 分钟内（`LIVE_MODELS_TTL`）直接返回，不再请求上游。
- **不回退**：超过新鲜期或带 `?refresh=true` 时一定重新请求；请求失败返回 `ok: false` 和错误信息，不会返回旧列表。
- **失效**：保存或删除密钥、修改或删除服务商配置、退出登录、登录完成、导入 OMP 凭据时，删除该服务商的缓存。跨越这些操作的探测结果不写入缓存，并返回 `ok: false`。
- **持久化**：成功结果写入 `live-models.json`（`0600`，只含模型 ID 与元数据），启动时载入仍在新鲜期内的条目。最多保留 128 家服务商。
- **前端**：`src/catalog.js` 以服务端返回的探测时间 `at` 计算有效期；探测失败或凭据变化时丢弃该服务商的列表，回到内置目录的模型。

## 出站代理

Node 内置的 `fetch` 不读取代理环境变量。插件启动时把全局 `fetch` 换成会读取代理设置的实现（`lib/proxy-fetch.mjs`），登录、密钥校验、额度查询和网关转发都经过它。

扩展设置中的“网络代理”决定走哪条路，保存在 `config.json`，立即生效：

| 模式 | 行为 |
|---|---|
| 使用系统代理（默认） | 先读下表的环境变量，没有可用的再读操作系统的代理设置 |
| 手动填写 | 只用填写的地址，支持 `http://`、`https://`、`socks5://`，可省略协议（`127.0.0.1:7890`）；`NO_PROXY` 仍然有效 |
| 不使用代理 | 全部直连 |

“测试连接”分别经当前代理和直连访问 `oauth2.googleapis.com`、`api.anthropic.com`、`auth.openai.com`、`api.github.com`，任何 HTTP 响应都算连通。操作系统的代理设置读不到时（Windows 的 PAC 模式、KDE、容器、Termux）请用手动填写。

| 变量 | 作用 |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | HTTPS 目标，经 HTTP `CONNECT` 或 SOCKS5 隧道 |
| `HTTP_PROXY` / `http_proxy` | HTTP 目标 |
| `ALL_PROXY` / `all_proxy` | 兜底代理，支持 `http://`、`https://`、`socks5://`（`socks5h://`、`socks://` 同义），忽略 SOCKS4 |
| `NO_PROXY` / `no_proxy` | 直连名单，支持 `*`、`*.example.com`、`.example.com`、`host:port` 与 IPv6 地址 |
| `OMTP_DISABLE_PROXY=1` | 完全停用该实现 |

没有可用的代理变量时，插件读取操作系统的代理设置：Windows 注册表、macOS `scutil --proxy`、Linux 上 GNOME 的 `gsettings`。结果缓存 10 秒，过期后的第一个请求会等这次读取完成（最多 1.5 秒），因此在 SillyTavern 启动后再打开 Clash 的“系统代理”，下一个请求就会走代理。两者都没有时直连。设置了 `OMTP_DISABLE_PROXY=1`，或 Node 24 及以上且设置了 `NODE_USE_ENV_PROXY=1` 时，插件不替换 `fetch`，“网络代理”设置不生效。

- 回环与私有网段（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`）始终直连。
- 隧道建立失败时改为直连，并记录一次日志；直连也失败时，错误信息同时给出代理的失败原因。请求已经写入隧道，或上游已经响应之后的失败不会重发，避免一次补全被计费两次。
- 经隧道跟随重定向时，跳到其他源会去掉 `Authorization`、`Cookie`、`Proxy-Authorization`、`x-api-key`、`api-key`、`x-goog-api-key`。

登录回调由单独的回环监听器接收，不经过代理。浏览器代理不绕过回环地址（如未设置 `--proxy-bypass-list="<-loopback>"`、使用 Proxifier 或某些安全软件的网页防护）、容器没有发布回调端口、浏览器在另一台机器上时，回调无法送达，面板会提示粘贴地址栏 URL。

## 数据文件

均位于 `<SillyTavern 数据目录>/omtp/`，目录权限 `0700`。

| 文件 | 格式 | 内容 |
|---|---|---|
| `config.json` | JSON | `autoStart`、`port`、`requireAuth`、`proxy`（`mode`、`url`；代理地址中的用户名密码以明文保存） |
| `gateway-token` | 文本，`0600` | 网关令牌（未加密） |
| `master.key` | 十六进制，`0600` | `providers.json` 的 AES-256-GCM 主密钥 |
| `providers.json` | JSON，`0600` | 加密的密钥、OAuth 令牌与服务商配置，每条形如 `enc:v1:…` |
| `install-id` | 文本，`0600` | 安装 ID（UUID v4），用于派生会话头 |
| `oauth-clients.json` | JSON，`0600`，可选 | 本机的 OAuth 客户端凭据 |
| `kimi-device-id` | 文本 | Kimi 登录使用的设备 ID |
| `usage-stats.json` | JSON，`0600` | 用量统计 |
| `live-models.json` | JSON，`0600`，可选 | 在线模型缓存 |
| `catalog.json` | JSON，可选 | 在线刷新得到的目录层 |
| `imported-catalog.json` | JSON，可选 | 从本地 OMP 导入的目录层 |

备份时至少同时保存 `master.key` 与 `providers.json`：缺少主密钥时已加密的凭据无法恢复。

## 环境变量

| 变量 | 作用 |
|---|---|
| `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY`、`NO_PROXY` | 出站代理，见[出站代理](#出站代理) |
| `OMTP_DISABLE_PROXY=1` | 停用代理支持 |
| `OMTP_STRICT_HOST=1` | 管理接口只接受白名单中的 Host |
| `OMTP_ALLOWED_HOSTS` | 逗号分隔，追加到 Host 白名单 |
| `OMTP_OMP_CATALOG_ROOTS` | 追加允许导入的 OMP 目录，以系统路径分隔符分隔 |
| `OMTP_<服务商>_CLIENT_ID`、`OMTP_<服务商>_CLIENT_SECRET` | 覆盖 OAuth 客户端凭据 |
| `PI_AI_CLAUDE_CODE_VERSION`、`PI_AI_GEMINI_CLI_VERSION`、`PI_AI_ANTIGRAVITY_VERSION`、`PI_AI_ANTIGRAVITY_CL` | 覆盖向服务商报告的客户端版本（默认值见 `lib/client-versions.mjs`）。Anthropic 拒绝过旧的 Claude Code 版本时可临时调高 |
| 目录声明的密钥变量（如 `OPENAI_API_KEY`） | 第三级凭据来源 |

## 安全边界

- **管理接口**：要求 `x-omtp-client: omtp-web` 请求头。浏览器发送自定义头前必须做 CORS 预检，SillyTavern 不放行预检，因此跨站网页无法调用这些接口。同时校验 `Origin` 与 `Host` 一致、`Sec-Fetch-Site` 不是 `cross-site`。不满足时返回 403 `untrusted_client`。从脚本调用的方法见[开发者 API](./developer.md#从脚本调用插件接口)。
- **Host 白名单**：`OMTP_STRICT_HOST=1` 时，管理接口只接受 `localhost`、`127.0.0.1`、`::1` 以及 `OMTP_ALLOWED_HOSTS` 中的 Host，用于防御 DNS rebinding。经反向代理使用公网域名时需要把域名加入白名单，因此默认关闭。
- **网关**：只监听 `127.0.0.1`，默认要求令牌。关闭鉴权必须在接口中显式确认，且关闭后只接受本机 Host。
- **凭据**：管理接口只返回凭据来源、末四位或掩码后的邮箱，不返回明文。`master.key` 内容无效时备份为 `master.key.corrupt-<时间戳>` 并报错，不会生成新密钥；`master.key` 缺失而 `providers.json` 中有密文时同样报错。
- **目录**：在线刷新与 OMP 导入的目录层只能修改模型列表、名称、价格等数据；`baseUrl`、`gatewayAdapter`、`authLogin`、请求头始终取自内置目录，以免被篡改的目录把密钥发往其他服务器。新服务商只能指向内置目录已有的主机或本机地址。刷新拒绝跨主机重定向。
- **OMP 导入**：只读取 `~/oh-my-pi`、`~/.omp` 与 `OMTP_OMP_CATALOG_ROOTS` 中的目录。
- **自定义 Base URL**：只接受不带查询串、不含账号密码的 http(s) URL，保存时与使用时各校验一次；已保存的无效值回退到内置端点。
- **OAuth 回调**：见 [OAuth 登录](#oauth-登录)。
- **伴随服务**：见下一节。

## 伴随服务（TauriTavern）

`node server-plugin/standalone.mjs` 在 SillyTavern 之外运行同一套管理接口与网关，供不能加载服务端插件的 TauriTavern 使用。`index.mjs`（SillyTavern）与 `standalone.mjs` 都只是 `lib/plugin.mjs` 的入口：前者提供 SillyTavern 的 Express 与密钥读取，后者提供 `lib/mini-express.mjs` 与令牌校验。

| 参数 | 默认值 | 说明 |
|---|---|---|
| `--data DIR` | `~/.omtp-companion` | 数据目录，状态写入 `DIR/omtp/`。指向 `SillyTavern/data` 可与 SillyTavern 共用密钥 |
| `--host ADDR` | `127.0.0.1` | 伴随服务与网关绑定的地址；`0.0.0.0` 供局域网内的其他设备使用 |
| `--port N` | `4099` | 伴随服务端口；网关仍使用自己的端口（默认 4100） |

- **管理接口**：挂在 `http://<host>:<port>/api/plugins/omtp`，路由与插件相同。请求来自 TauriTavern WebView 的其他源，所以 `Origin` 校验不适用，改为要求 `x-omtp-client: omtp-web` 与 `x-omtp-token: <令牌>`。令牌在首次启动时生成，保存在 `companion-token`（`0600`），启动时打印。CORS 预检回显请求的 `Origin` 与请求头。
- **`GET /health`**：无需令牌，返回 `{ok:true, service:'omtp-companion'}`。
- **SillyTavern 密钥**：伴随服务读不到 SillyTavern 或 TauriTavern 的 `secrets.json`，凭据只来自 OMTP 自己的密钥库与环境变量。
- **网关**：与插件相同；`--host` 也决定网关的绑定地址。客户端把伴随服务报告的 `127.0.0.1` 换成伴随服务的主机名后写入 `custom_url`。TauriTavern 第一次连接该地址时会请求用户授权。
- **统计页面**：仍只监听 `127.0.0.1`。
