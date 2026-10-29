[English](./CONTRIBUTING.en.md) | [简体中文](./CONTRIBUTING.md)

# Contributing to OMTP Model Hub / 贡献指南

感谢你愿意为 **OMTP Model Hub (Oh-My-Tavern-Providers)** 做出贡献！
本文描述当前 **SillyTavern 客户端扩展（`src/` + `index.js`）** 与 **可选服务端网关插件（`server-plugin/`）** 的真实模块边界、开发调试工作流、质量护栏与提交规范。请以源码和运行行为为准同步维护文档。

---

## 项目定位与边界 / Scope

- **核心定位**：OMTP 是面向 SillyTavern 1.12.7+ 的统一模型选择中枢与可选本机协议转换网关。
- **双层独立架构**：
  - **客户端扩展（`src/`、`index.js`、`style.css`、`settings.html`、`i18n/`）**：运行在浏览器端，通过相对路径直接导入 SillyTavern 宿主模块（`script.js`、`extensions.js`、`popup.js`、`events.js` 等），无打包构建步骤（零 bundler）。
  - **服务端插件（`server-plugin/`）**：会被用户独立复制到 `SillyTavern/plugins/omtp/` 运行，因此 **`server-plugin/` 绝不能直接 `import` 仓库根目录或 `src/` 下的客户端文件**；两端共享的常量或目录副本必须各自独立维护。
- **零外部进程依赖**：严禁在运行时调用外部 `omp` 二进制或要求 Python 环境；所有能力均由纯 JavaScript / Node.js 实现。

---

## 文档地图 / Documentation Map

修改代码时，请按职责同步更新对应文档：

| 文档路径 | 面向读者与职责 |
|---|---|
| [`README.md`](./README.md) / [`README.en.md`](./README.en.md) | 面向所有用户：项目定位、亮点、30 秒安装、3 分钟上手、核心功能与 FAQ |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) / [`CONTRIBUTING.en.md`](./CONTRIBUTING.en.md) | 面向贡献者：模块架构边界、代码风格、测试门禁与 PR 规范 |
| [`docs/gateway.md`](./docs/gateway.md) / [`docs/gateway.en.md`](./docs/gateway.en.md) | 网关端口/鉴权、24 条插件 HTTP 路由、9 类协议适配器、16 家额度接口、`data/omtp/` 存储规格 |
| [`docs/developer.md`](./docs/developer.md) / [`docs/developer.en.md`](./docs/developer.en.md) | `globalThis.OMTP` 公开 API、选择器语法、目录与人格快照构建脚本、本地 Mock 联调 |
| [`tests/e2e/README.md`](./tests/e2e/README.md) | 在真实 SillyTavern 宿主中执行手工端到端验证的步骤清单 |

---

## 开发环境与脚本命令 / Development Environment

- **Node.js**：`>= 18.0.0`（开发与运行单元测试建议使用 Node.js 20+ / 22+，使用内置 `node --test` 与 `node:sqlite`）
- **SillyTavern**：`>= 1.12.7`（兼容至 `1.19.0+`）
- **依赖说明**：客户端与单元测试完全零第三方运行时依赖；`server-plugin/` 仅在 SillyTavern 宿主进程内复用宿主自带的 `express`。

### 常用命令

```bash
# 1. 运行全量单元测试（Node.js 原生 test runner，当前 13 个测试文件 / 69 项用例）
npm test

# 2. 校验内置模型目录（检查 99 家服务商、5,770+ 模型、44 个原生适配器映射及主从目录字节一致性）
npm run validate

# 3. 从本地 oh-my-pi 仓库重新生成双副本目录（默认读取 ~/oh-my-pi）
npm run catalog -- --omp-root /path/to/oh-my-pi

# 4. 校验或更新 AA-PersonalityBench 八维人格快照（catalog/personality.json）
npm run personality:verify
npm run personality

# 5. 启动本地零成本 Mock OpenAI 上游服务（监听 http://127.0.0.1:4199/v1）
npm run mock
```

---

## 项目结构与模块归属 / Project Layout

```text
Oh-My-Tavern-Providers/
├── index.js                      # 客户端扩展入口（挂载并自动调用 hub.init()）
├── settings.html                 # 扩展设置面板静态模板（DOM ID 是与 settings.js 绑定的契约）
├── style.css                     # 全部前端样式（面板、登录页、用量页、快速选择器、设置抽屉）
├── i18n/
│   ├── en.json                   # 英文语言包（与 zh-cn.json 键集必须 1:1 严格对齐）
│   └── zh-cn.json                # 简体中文语言包
├── catalog/
│   ├── omtp-catalog.json         # 客户端内置模型目录（与 server-plugin 下副本字节严格一致）
│   └── personality.json          # AA-PersonalityBench 41 模型八维人格分位快照
├── src/                          # 客户端核心与 UI 模块（ES Modules）
│   ├── constants.js              # 路由常量、主流服务商白名单 (52)、AI 实验室列表 (33)、事件名
│   ├── store.js                  # extension_settings.omtp 读写、EntryRef 校验与序列化 (getEntryKey)
│   ├── catalog.js                # 目录加载、多层合并、原生/网关路由判定、实时模型探测缓存
│   ├── selector.js               # 纯函数选择器词法/语法解析与排序（严禁引入 SillyTavern 宿主依赖！）
│   ├── switch-engine.js          # 核心切换引擎：原生控件写入、Custom 源快照/恢复、并发锁、请求头同步
│   ├── public-api.js             # globalThis.OMTP 注入与生命周期清理
│   ├── slash-commands.js         # /omtp、/model、/switch、/effort、/usage 斜杠命令注册
│   ├── personality.js            # 八维人格雷达 SVG 绘制与 OMTP RP 加权分计算
│   ├── personality-match.js      # 模型 ID 到人格基准键的归一化匹配（纯函数）
│   ├── provider-names.js         # 服务商官方中文名与地区后缀翻译
│   ├── reasoning.js              # 模型推理档位能力判定
│   ├── usage-session.js          # 当前对话 Token 统计时间窗基线管理
│   ├── events.js                 # 宿主事件桥接与清理
│   ├── adapters/
│   │   └── native.js             # SillyTavern 44 类原生适配器定义表（冻结对象）
│   └── ui/
│       ├── helpers.js            # 共享 UI 工具（el, isPlainObject, notify, formatTokens, formatUsd）
│       ├── dom.js                # 翻译辅助 tr/trf、顶栏按钮与 API 抽屉工具注入、全局热键
│       ├── hub.js                # 模型中心门面模块（生命周期 init/teardown、事件挂载、对外导出）
│       ├── hub-state.js          # 跨 hub 子模块共享的响应式状态单例
│       ├── hub-utils.js          # 条目键控 (entryKey/refKey)、收藏/最近/槽位判定
│       ├── hub-catalog.js        # 面板目录加载、服务商可用性分桶、主流/评分过滤
│       ├── hub-sidebar.js        # 左侧服务商栏渲染、搜索联动与实时模型刷新
│       ├── hub-list.js           # 中间模型列表、分组搜索、收藏/最近/配置档案视图
│       ├── hub-details.js        # 右侧详情区、八维人格雷达挂载、推理档位与操作栏
│       ├── hub-quick.js          # 顶部 1–9 快速槽位栏、顶栏高亮与脚部统计
│       ├── hub-actions.js        # 使用模型、对话/角色绑定切换、跳转服务商设置、复制选择器
│       ├── hub-modal.js          # 模态框 DOM 构建、网关状态胶囊、键盘导航与焦点陷阱
│       ├── login-panel.js        # 登录中心（OAuth PKCE / 设备码 / 自定义钩子 / API Key 掩码录入）
│       ├── usage-panel.js        # 服务商实时额度进度条与会话/累计 Token 统计表
│       ├── usage-chip.js         # 聊天顶栏实时 Token 与预估费用徽章
│       ├── about-panel.js        # 关于页（版本、网关状态、数据致谢与许可证）
│       ├── quick-picker.js       # /switch 无参呼出的终端风键盘快速选择器
│       ├── settings.js           # 扩展设置抽屉绑定、自定义服务商弹窗、本地 OMP 导入弹窗
│       ├── bindings.js           # 对话/角色模型自动绑定状态机与防抖切换
│       └── extra-body.js         # 单模型自定义附加请求体 JSON 编辑器与生成钩子注入
├── server-plugin/                # 可选 SillyTavern 服务端插件（独立部署至 plugins/omtp/）
│   ├── index.mjs                 # 插件入口：注册 24 条 /api/plugins/omtp 路由、管理网关与统计服务
│   ├── catalog/omtp-catalog.json # 服务端自带目录副本（必须与 catalog/omtp-catalog.json 字节一致）
│   └── lib/
│       ├── gateway-server.mjs    # 独立 OpenAI 兼容网关（127.0.0.1:4100–4110）、流式计费分流器
│       ├── key-store.mjs         # AES-256-GCM 密钥库（providers.json + master.key）与三级密钥解析
│       ├── provider-config.mjs   # 服务商上下文构建、9 类受支持适配器校验、探针地址推导
│       ├── catalog-service.mjs   # 服务端四层目录合并（内置 -> 远程刷新 -> OMP 导入 -> 自定义服务商）
│       ├── catalog-normalize.mjs # OMP 原始数据归一化与 validateCatalog 校验器
│       ├── login-engine.mjs      # OAuth PKCE 回环监听、RFC 8628 设备码轮询、自定义登录钩子调度
│       ├── oauth.mjs             # 结构化 OAuth 凭据解析与过期自动刷新
│       ├── oauth-clients.mjs     # 公开 client_id 与本地 Google 系 client_secret 的解析（env -> oauth-clients.json）
│       ├── import-omp.mjs        # 本地 oh-my-pi 目录与 agent.db SQLite 凭据安全导入
│       ├── usage.mjs             # 16 家服务商实时额度查询适配器与 60 秒缓存
│       ├── stats.mjs             # Token 与缓存/推理费用计算、按对话/模型/日期持久化账本
│       ├── stats-server.mjs      # /omtp stats 独立可视化仪表盘 HTTP 服务（默认端口 3847）
│       ├── sse.mjs               # OpenAI SSE 帧解析与构造工具
│       ├── redact.mjs            # 控制台日志辅助
│       ├── custom-logins/        # openai-codex-device、kilo、kimi-fingerprint 专属登录实现
│       └── adapters/             # 9 类上游协议转换器（openai, anthropic, google, google-vertex, antigravity, responses, azure-responses, bedrock, ollama）
├── tools/                        # 离线维护脚本（build-catalog, validate-catalog, fetch-personality）
└── tests/                        # 单元测试（tests/unit/*.test.mjs）与 Mock 服务（tests/fixtures/）
```

---

## 质量护栏与关键契约 / Quality Guardrails

提交 PR 前，请确认没有破坏以下核心契约：

1. **纯函数模块隔离**：
   - `src/selector.js` 与 `src/personality-match.js` 必须保持**零 SillyTavern 宿主导入**，以便在纯 Node.js 环境中直接运行单元测试。
2. **主从目录双副本同步**：
   - `catalog/omtp-catalog.json` 与 `server-plugin/catalog/omtp-catalog.json` 必须保持**字节完全一致**。修改目录生成逻辑或映射表后，必须运行 `npm run validate` 确认通过。
3. **双语翻译键 1:1 同步**：
   - `i18n/en.json` 与 `i18n/zh-cn.json` 的键集合与顺序必须完全一致。新增 UI 文案时需同时写入两份文件；不要删除动态拼接键族（`omtp_pb_*`、`omtp_source_*`、`omtp_stats_col_*`）。
4. **安全与加密底线**：
   - 严禁在代码、目录或测试夹具中硬编码真实的 API Key、OAuth `client_secret` 或个人路径。
   - 目录只允许携带**公开的应用标识**（`client_id`）；Google 系（`google-antigravity`、`google-gemini-cli`）的 `client_id` + `client_secret` 必须留在本地，由 `LOCAL_ONLY_CLIENTS`（`catalog-normalize.mjs`）强制。
   - `key-store.mjs` 遇到无法解密的密文时必须抛出 `KeyStoreUnreadableError`（映射为 HTTP `409`），**绝不能静默覆盖损坏用户的 `providers.json`**。
   - 网关 Bearer 令牌校验必须保持 `tokensEqual` 常量时间比对。
5. **无损切换与回滚顺序**：
   - `switch-engine.js` 中写入 SillyTavern 控件并轮询等待状态落盘的顺序、进入网关前保存 `savedCustom` 快照、以及 `hub.js` 卸载时 `restorePreviousSelection -> cleanupHubSurfaces -> resetHubState` 的顺序不可打乱。

---

## 代码风格与测试要求 / Style & Testing

- **代码风格**：
  - ES Modules（客户端 `.js`，服务端与工具 `.mjs`）。
  - **4 空格缩进**、单引号字符串、语句末尾加分号、函数顶部使用简洁的 JSDoc 注释。
  - 删除复述代码字面意思的废话注释，只保留解释**为什么这样做（意图、边界、宿主坑点）**的注释。
- **测试准则**：
  - 提交前必须通过 `npm test` 与 `npm run validate`，且对所有修改的 `.js`/`.mjs` 文件执行 `node --check`。
  - **编写有价值的测试**：只为真实的业务逻辑、协议转换边界、加密存取与回归缺陷编写测试；**不要**编写测试源码文本字符串、Mock 回声或空洞不抛错的冗余测试。

---

## 提交流程 / Pull Request Workflow

1. Fork 本仓库并从 `main` 创建功能或修复分支（如 `feat/provider-xxx` 或 `fix/gateway-xxx`）。
2. 完成代码修改，确保本地通过：
   ```bash
   npm test
   npm run validate
   ```
3. 如涉及 UI 改动，请在本地 SillyTavern 中实际打开面板验证交互，并在 PR 中附上截图或录屏。
4. 按照 PR 模板填写变更背景、测试方式与检查清单并提交 Pull Request。
