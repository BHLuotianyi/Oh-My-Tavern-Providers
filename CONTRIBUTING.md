[English](./CONTRIBUTING.en.md) | 简体中文

# 贡献指南

本文说明 OMTP 的代码结构、必须保持的约束，以及提交改动的流程。

## 项目结构

OMTP 由两个独立部署的部分组成：

- **客户端扩展**：`index.js`、`src/`、`settings.html`、`style.css`、`i18n/`、`catalog/`。在浏览器中运行，用相对路径直接导入 SillyTavern 的模块（`script.js`、`extensions.js`、`popup.js` 等）。没有打包步骤。
- **服务端插件**：`server-plugin/`。用户把它复制到 `SillyTavern/plugins/omtp/`，在 SillyTavern 的 Node 进程中运行。

运行时不调用 `omp` 程序，也不需要 Python。读取本地 OMP 凭据时会依次尝试 `node:sqlite`、`sqlite3` 命令和 `python3`，三者都没有时该功能不可用，其余功能不受影响。

```text
index.js                 扩展入口，转发到 src/ui/hub.js
settings.html            扩展设置面板模板，元素 ID 由 src/ui/settings.js 使用
i18n/                    界面文案（en、zh-cn）
catalog/                 客户端使用的目录与人格评分快照
src/
  catalog.js             目录加载与合并、连接方式判定、在线模型缓存
  switch-engine.js       写入 SillyTavern 设置、进入与退出网关模式
  selector.js            选择器解析与排序
  store.js               扩展设置与 EntryRef
  public-api.js          globalThis.OMTP
  slash-commands.js      斜杠命令
  update-check.js        更新判定
  adapters/native.js     SillyTavern 原生来源的描述
  ui/                    面板、登录、用量、设置、绑定等界面模块
server-plugin/
  index.mjs              插件入口与管理接口
  catalog/               插件自带的目录副本
  lib/
    gateway-server.mjs   网关
    adapters/            上游协议适配器
    key-store.mjs        加密密钥库与凭据解析
    login-engine.mjs     OAuth 与设备码登录
    catalog-service.mjs  服务端目录分层合并
    usage.mjs            额度查询
    stats.mjs            用量统计与计费
    proxy-fetch.mjs      出站代理
tools/                   目录构建、校验、人格数据、版本号脚本
tests/unit/              单元测试
tests/fixtures/          本地模拟服务
docs/                    文档
```

## 开发环境

- Node.js 18 或更高版本。不需要 `npm install`：客户端与测试只用 Node 自带模块，插件使用 SillyTavern 自带的 `express`。
- 在真实 SillyTavern 中调试：把仓库克隆（或链接）到 `public/scripts/extensions/third-party/omtp-model-hub/`，并把 `server-plugin/` 复制到 `plugins/omtp/`。改动插件代码后需要重新复制并重启 SillyTavern。

```bash
npm test                    # 单元测试
npm run validate            # 目录校验
npm run mock                # 本地模拟服务，见 docs/testing.md
npm run catalog -- --omp-root /path/to/oh-my-pi   # 重新生成目录
npm run personality         # 更新人格评分快照
npm run personality:verify  # 只检查人格指数的推导
```

## 必须保持的约束

1. **插件独立**：`server-plugin/` 不能导入仓库根目录或 `src/` 下的文件，两边需要的常量和目录各自维护一份。`server-plugin/index.mjs` 中的 `../../src/…` 指向的是 SillyTavern 自己的模块。
2. **不依赖宿主的模块**：`src/constants.js`、`src/selector.js`、`src/personality-match.js`、`src/update-check.js`、`src/profile-fields.js`、`src/reasoning.js` 不能导入 SillyTavern 模块，单元测试直接在 Node 中加载它们。
3. **两份目录相同**：`catalog/omtp-catalog.json` 与 `server-plugin/catalog/omtp-catalog.json` 必须逐字节相同。`npm run catalog` 同时写两份，`npm run validate` 检查。
4. **文案键一致**：`i18n/en.json` 与 `i18n/zh-cn.json` 的键集合相同。新增文案时两边同时添加。`omtp_pb_*`、`omtp_source_*`、`omtp_stats_col_*`、`omtp_tab_*` 等键由代码拼接使用，搜索不到引用也不要删除。
5. **版本号一致**：四个版本文件由 `tools/version.mjs` 写入，不要手动修改，见 [版本与发布](./docs/releasing.md)。
6. **凭据**：
   - 代码、目录、测试数据中不能包含真实的 API 密钥、令牌或个人路径。
   - 目录中的 OAuth 客户端值是公开标识；是否内置由 `server-plugin/lib/catalog-normalize.mjs` 的 `LOCAL_ONLY_CLIENTS` 决定，修改时在 PR 中说明理由。
   - `key-store.mjs` 遇到无法解密的数据必须抛出 `KeyStoreUnreadableError`（管理接口返回 409），不能覆盖用户的 `providers.json` 或重新生成 `master.key`。
   - 网关令牌用 `tokensEqual` 做常量时间比较。
7. **切换与恢复的顺序**：`switch-engine.js` 写入 SillyTavern 控件并等待其生效的顺序、进入网关模式前保存 Custom OpenAI 设置，以及 `src/ui/hub.js` 停用时 `restorePreviousSelection → cleanupHubSurfaces → resetHubState` 的顺序不能打乱。
8. **用量口径**：适配器输出的 `usage` 中，`completion_tokens` 包含推理 token，推理数放在 `completion_tokens_details.reasoning_tokens`。计费逻辑依赖这一点，见 [服务端插件参考](./docs/gateway.md#用量统计与计费)。

## 目录与人格数据

- **目录**：`tools/build-catalog.mjs` 读取 OMP 仓库中的 `packages/catalog/src/models.json`（紧凑格式，由 `server-plugin/lib/omp-models-format.mjs` 解码）与 `compat/rules.json`，结合 `tools/provider-map.source.json`（服务商到 SillyTavern 原生来源与网关适配器的映射）和 `tools/native-adapter-keys.json`，生成两份目录。只保留聊天模型。
- **客户端版本**：`server-plugin/lib/client-versions.mjs` 集中存放冒充的客户端版本（Claude Code、Gemini CLI、Antigravity、Kimi CLI），以 OMP 为准，与目录一起更新。版本过旧时 Anthropic 会拒绝新模型（"version X or newer is required"），Antigravity 会隐藏新模型。
- 服务商数量或模型数变化时，同步修改 `server-plugin/lib/catalog-normalize.mjs` 中的 `CATALOG_EXPECTATIONS`，否则 `npm run validate` 失败。
- **人格评分**：`tools/fetch-personality.mjs` 从 AA-PersonalityBench 页面解析数据，写入 `catalog/personality.json`；页面缓存在 `.cache/`。AA 只为部分模型公布八项指数，其余模型由公开的特质分按其方法推导，每次运行都会打印公布值与推导值的差异。

## 代码风格

- ES Modules：客户端用 `.js`，插件与工具用 `.mjs`。
- 4 空格缩进，单引号，语句以分号结尾。
- 导出的函数写简短的 JSDoc。
- 注释说明原因（意图、边界条件、宿主的特殊行为），不复述代码。

## 测试

提交前运行 `npm test` 和 `npm run validate`，并对改动的 `.js` / `.mjs` 文件运行 `node --check`。

测试应当能发现真实的问题：业务规则、协议转换的边界、加密存取、修复过的缺陷。不要写只检查源码文本、只回显 mock、或只断言「不抛错」的测试。测试必须确定、互相独立，不依赖网络。

手工检查步骤与本地模拟服务见 [测试](./docs/testing.md)。

## 文档

| 改动 | 需要更新 |
|---|---|
| 用户可见的功能或设置 | `docs/user-guide*.md`，必要时 README |
| 插件接口、数据文件、环境变量、安全行为 | `docs/gateway*.md` |
| `globalThis.OMTP` 或选择器 | `docs/developer*.md` |
| 版本或发布流程 | `docs/releasing*.md` |

中英文文档同步修改。文档只写当前行为，不写营销语言；容易过时的数字（服务商数、路由数）尽量不写，必须写时给出来源。

## 提交 Pull Request

1. Fork 仓库，从 `main` 创建分支，如 `fix/gateway-port` 或 `feat/provider-foo`。
2. 完成改动并通过上面的检查。
3. 界面改动在 SillyTavern 中实际验证，并在 PR 中附截图或录屏。
4. 按 PR 模板填写说明。提交信息使用 Conventional Commits 格式（`fix(scope): …`、`feat(scope): …`、`docs: …`）。
