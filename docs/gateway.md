[English](./gateway.en.md) | [简体中文](./gateway.md) | [返回首页 / Back to README](../README.md)

# 本地网关与服务端架构参考 / Gateway Reference

本文档收录 OMTP 服务端插件（`server-plugin/`）的完整 HTTP 路由表、协议适配器矩阵、本地数据文件规格与额度接口明细。普通用户只需阅读 [README 快速开始](../README.md#快速开始--getting-started) 即可完成安装。

---

## 1. 网关监听与鉴权机制

- **默认地址**：`http://127.0.0.1:4100/v1`（仅绑定本机回环 `127.0.0.1`，不对外网暴露）。
- **端口顺延**：若 `4100` 被占用，自动在 `4100–4110` 范围内顺延，或复用已运行的 `omtp-gateway` 实例；客户端通过 `/api/plugins/omtp/status` 自动同步实际端口。
- **鉴权方式**：默认启用 Bearer Token 校验（采用 `crypto.timingSafeEqual` 常量时间比对）。令牌首次启动时生成并以 `0600` 权限明文保存在 `data/omtp/gateway-token`，由 `GET /api/plugins/omtp/gateway/token` 提供给本机前端自动注入。

### 独立网关 HTTP 路由 (`127.0.0.1:4100`)

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| `GET` | `/health` | 无 | 健康检查，返回 `{ ok, service: 'omtp-gateway', version, catalogVersion }` |
| `GET` | `/v1/models` | Bearer（默认开启） | 返回当前网关可用（含有效凭据或免密）的 `provider/model` 列表 |
| `POST` | `/v1/chat/completions` | Bearer（默认开启） | OpenAI 兼容聊天补全入口，支持流式 SSE 与非流式 JSON，读取 `X-OMTP-Chat` 记账 |

---

## 2. SillyTavern 插件管理路由 (`/api/plugins/omtp`)

所有管理路由挂载于 SillyTavern 宿主进程下，复用 SillyTavern 自身的会话与 CSRF 校验，共 **24 条路由**：

| 分类 | 方法与路径 | 说明 |
|---|---|---|
| **状态与网关** | `GET /status` | 插件版本、网关运行状态与端口、目录统计 |
| | `GET /gateway/token` | 读取本机网关 Bearer 令牌 |
| | `POST /gateway/restart` | 重启本地网关监听 |
| | `GET /config` · `POST /config` | 读取或更新 `autoStart`、`port`、`requireAuth` |
| **目录与导入** | `GET /catalog` | 获取合并后的完整目录（OAuth 客户端字段已按策略归一化：公开客户端对保留，其余剥离为环境变量引用） |
| | `POST /catalog/refresh` | 从指定 `http(s)` URL 或默认上游刷新 `catalog.json` |
| | `POST /import/omp` | 从本地 `oh-my-pi` 目录导入模型覆盖层与 `agent.db` 凭据 |
| **服务商与密钥** | `GET /providers` | 列出所有服务商的可用性、凭据来源、后四位掩码、登录方式与模型数 |
| | `POST /providers/:id/key` · `DELETE /providers/:id/key` | 加密保存或清除单个服务商 API Key |
| | `POST /providers/:id/config` · `DELETE /providers/:id/config` | 新增/更新或删除自定义服务商配置（`label/adapter/baseUrl/headers/extraConfig/models`） |
| | `POST /providers/:id/test` | 使用真实适配器向上游发起探针测试连通性 |
| | `GET /providers/:id/models` | 调用上游 `/models` 实时探测可用模型列表（支持 `?refresh=true`） |
| **OAuth 与登录** | `POST /providers/:id/login` | 启动 `oauth-code`、`device-code` 或 `custom` 登录会话 |
| | `GET /providers/:id/login/:session` | 轮询登录会话状态（`pending` / `done` / `error`） |
| | `POST /providers/:id/login/:session/code` | 手动粘贴回调 URL 或授权码完成 `oauth-code` 登录 |
| | `DELETE /providers/:id/login/:session` | 取消进行中的登录会话 |
| | `POST /providers/:id/logout` | 退出登录并清除存储凭据 |
| **用量与统计** | `GET /usage` | 查询各订阅服务商的实时额度窗口与余额（60 秒缓存，`?refresh=true` 强制刷新） |
| | `GET /stats` | 查询累计、按对话（`?chat=`）或按时间（`?since=`）的 Token 与费用统计 |
| | `GET /stats/server` · `GET /stats/server/status` | 启动（或复用）独立统计面板服务（默认端口 `3847`）或查询其状态 |

**登录回调策略**（来自目录的 `authLogin.callback`）：

| 字段 | 行为 |
|---|---|
| `redirectUri` | 声明值优先：`http://` 回环地址会按原 host/port/path 监听；`zcode://`、`vscode://` 等自定义协议无法被本机接收，自动转为手动粘贴 |
| `manualOnly` | 不启动本地监听，只返回授权链接与粘贴框说明 |
| `nativeScheme` | 同上（本插件没有 OS 协议处理器） |
| `portFallback` | 端口被占用时不再返回一个无人监听的 `redirect_uri`，而是降级为手动粘贴并在 `instructions` 里说明原因 |

**兑换后钩子**（`authLogin.afterExchange`）：`zai-mint-key`（把短期 OAuth 令牌换成长期 API Key）、`anthropic-identity`（账号/组织信息）、`openai-codex-profile`、`google-gemini-cli-project` / `google-antigravity-project`（项目 ID）、`muse-code-key`、`factory-droid-region`、`gitlab-duo-clear-cache`。未知钩子只记录日志，不会中断登录。

---

## 3. 协议适配器矩阵 (9 类)

| 适配器 ID | 上游协议 | 关键特性 |
|---|---|---|
| `openai` | OpenAI Chat Completions | 通用兼容协议，透传流式 SSE、工具调用与 `reasoning_content` |
| `anthropic` | Anthropic Messages | 自动处理系统提示词、工具 schema 转换、思考块与 Claude Code OAuth 指纹 |
| `google` | Google Generative AI | Gemini 原生接口，保留 `cachedContentTokenCount` 与 `thoughtsTokenCount` |
| `google-vertex` | Google Cloud Vertex AI | 支持服务账号 JSON / ADC 令牌交换与企业区域端点 |
| `antigravity` | Cloud Code Assist (`v1internal`) | 支持 Google Antigravity 与 Gemini CLI OAuth 会话，内置多端点自动故障转移 |
| `responses` | OpenAI Responses API | 将 Chat Completions 转换为 `/responses` 规范，保留推理与缓存计数 |
| `azure-responses` | Azure OpenAI Responses | 适配 Azure 专属部署路径、`api-key` 头与 `api-version` |
| `bedrock` | Amazon Bedrock Converse | 支持 AWS AK/SK 签名或 Bearer Token，将 Converse 响应合成为标准 OpenAI SSE 流 |
| `ollama` | Ollama Chat | 适配本地 Ollama `/api/chat` 与 `/v1` 接口（免密） |

> **不可转发的服务商说明**：仅支持专有客户端协议或未公开无头登录链路的服务商（`apple`、`cursor`、`devin`、`github-copilot`、`gitlab-duo`、`gitlab-duo-agent`、`stencil`、`xai-oauth`）以及纯搜索/非对话源（`exa`、`kagi`、`parallel`、`perplexity`、`tavily`、`typesafe`、`web`）在面板中会保留展示并标明不可选原因。

---

## 4. 实时额度支持列表 (`USAGE_PROVIDERS`)

| 服务商 | 上游额度接口 | 展示内容 |
|---|---|---|
| Google Antigravity / Gemini CLI | `POST /v1internal:retrieveUserQuotaSummary` | 按模型族展示周度 / 5 小时窗口使用率 |
| OpenAI Codex / ChatGPT 套餐 | `GET chatgpt.com/backend-api/wham/usage` | 主/次级窗口使用率与套餐名称 |
| Anthropic Claude Pro / Max | `GET api.anthropic.com/api/oauth/usage` | 5 小时 / 7 天窗口及额外用量余额 |
| Z.AI / 智谱 Coding Plan | `GET api.z.ai/api/monitor/usage/quota/limit` | Token / 时间 / 额度窗口（原始 Token 鉴权） |
| Kimi Code | `GET api.kimi.com/coding/v1/usages` | 各周期窗口已用/剩余百分比 |
| MiniMax Token Plan (国际 / 国内) | `GET {api.minimax.io\|api.minimaxi.com}/v1/token_plan/remains` | 按模型展示 5 小时 / 周度剩余额度 |
| xAI (SuperGrok) | `GET cli-chat-proxy.grok.com/v1/billing?format=credits` | 周度额度 / 月度包含额度 / 按需计费 |
| GitHub Copilot | `GET api.github.com/copilot_internal/user` | Premium / Chat / Completions 配额快照与重置时间 |
| OpenCode Go | `GET opencode.ai/zen/go/v1/usage` | 5 小时 / 周度 / 月度滚动窗口 |
| Cursor | `GET api2.cursor.sh/auth/usage` | 账单周期请求配额 |
| Command Code | `GET api.commandcode.ai/alpha/billing/credits` | 5 小时 / 周度窗口与积分余额 |
| ClinePass | `GET api.cline.bot/api/v1/users/me/plan/usage-limits` | 5 小时 / 周度 / 月度限额窗口 |
| Synthetic | `GET api.synthetic.new/v2/quotas` | 5 小时 / 周度滚动配额 |
| Umans | `GET api.code.umans.ai/v1/usage` | 请求窗口与突发上限 |
| Charm Hyper | `GET hyper.charm.land/v1/credits` | 账户积分余额 |
| DeepSeek | `GET api.deepseek.com/user/balance` | 按币种显示预充值账户余额 |

---

## 5. 本地数据文件与三级密钥解析 (`$DATA_ROOT/omtp/`)

| 文件名 | 权限 / 加密 | 用途 |
|---|---|---|
| `config.json` | JSON | 网关配置：`autoStart`、`port`、`requireAuth` |
| `gateway-token` | `0600` 明文 hex | 本地网关 Bearer 通信令牌（非加密，仅本机可读） |
| `master.key` | `0600` 32 字节 hex | 用于加密 `providers.json` 的 AES-256-GCM 主密钥 |
| `providers.json` | `0600` AES-256-GCM | 加密存储的服务商 API Key、OAuth 令牌与自定义服务商配置（`enc:v1:...`） |
| `oauth-clients.json` | `0600` JSON（可选） | 用户自行配置的 OAuth `clientId` / `clientSecret` |
| `kimi-device-id` | 文本 | `kimi-fingerprint` 登录钩子生成的稳定设备指纹 ID |
| `usage-stats.json` | JSON | 按对话、模型、日期持久化的 Token 与预估费用账本 |
| `catalog.json` | JSON（可选） | 在线刷新拉取的目录缓存层 |
| `imported-catalog.json` | JSON（可选） | 从本地 `oh-my-pi` 导入生成的增量目录覆盖层 |

**三级密钥解析优先级**（由高到低）：
1. **OMTP 加密密钥库**（`data/omtp/providers.json`）
2. **SillyTavern Secrets**（默认用户的 `secrets.json`，如 `api_key_openai`、`api_key_claude` 等）
3. **系统环境变量**（各服务商在目录中声明的 `env` 变量，如 `OPENAI_API_KEY`）

---

## 6. 出站代理

Node 内置 `fetch` 不读取代理环境变量，因此服务端插件启动时会把全局 `fetch` 替换为代理感知实现（`lib/proxy-fetch.mjs`），覆盖登录、密钥校验、额度查询与网关转发：

| 变量 | 作用 |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | HTTPS 目标（经 HTTP `CONNECT` 隧道） |
| `HTTP_PROXY` / `http_proxy` | HTTP 目标 |
| `ALL_PROXY` / `all_proxy` | 兜底代理（仅支持 `http://` / `https://`，SOCKS 会被忽略） |
| `NO_PROXY` / `no_proxy` | 直连名单：支持 `*`、`*.example.com`、`.example.com`、`host:port` 与 IPv6 字面量 |
| `OMTP_DISABLE_PROXY=1` | 完全关闭该包装 |

回环与私有网段（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`）始终直连。隧道建立失败时回退直连；请求已经写入隧道后的失败不会重放，避免重复计费的补全请求。
