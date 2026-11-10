[English](./testing.en.md) | 简体中文 | [返回 README](../README.md)

# 测试

## 自动检查

```bash
npm test           # 单元测试（node --test，运行 tests/unit/*.test.mjs）
npm run validate   # 目录校验
```

- 单元测试只依赖 Node 自带模块，不需要安装依赖。CI 在 Node 18、20、22 上运行（`.github/workflows/checks.yml`）。
- 只跑一个文件：`node --test tests/unit/proxy-fetch.test.mjs`。
- `npm run validate` 检查两份目录（`catalog/` 与 `server-plugin/catalog/`）的结构、原生适配器映射，以及两份文件是否完全相同。
- 修改过的 `.js` / `.mjs` 文件可以用 `node --check <文件>` 做语法检查。

编写测试的要求见 [贡献指南](../CONTRIBUTING.md#测试)。

## 本地模拟服务

`tests/fixtures/mock-openai.mjs` 是一个 OpenAI 兼容的模拟上游，用来在不消耗额度的情况下检查网关：

```bash
npm run mock        # 监听 http://127.0.0.1:4199/v1，可用 PORT 环境变量修改
```

它提供一个 `echo` 模型：消息含 `ping` 时回复 `pong`，否则回复 `echo: <消息>`；支持流式输出，并在最后一个流式块中返回 `usage`。

在 OMTP 中接入：打开面板的 **登录** 标签页，点击 **添加自定义服务商**，填写：

| 字段 | 值 |
|---|---|
| ID | `mock` |
| 名称 | `Mock` |
| 适配器 | `openai` |
| Base URL | `http://127.0.0.1:4199/v1` |
| 模型 | `echo` |
| 密钥 | 任意非空值 |

之后在 **全部** 标签页选择 `mock/echo` 即可。

## 手工端到端检查

在真实的 SillyTavern 中验证改动时使用。前提：

- 客户端扩展安装在 `public/scripts/extensions/third-party/omtp-model-hub/`；
- 服务端插件安装在 `plugins/omtp/`，`enableServerPlugins: true`；
- 模拟服务已运行，并按上文添加了 `mock` 服务商。

### 浏览器

1. 加载 SillyTavern：`#main-API-selector-block` 被隐藏，存在 `#omtp-hub-button`。
2. 打开面板，搜索 `claude`，选中一个原生控件中存在的模型并使用。`#main_api`、`#chat_completion_source` 与模型控件的值对应，刷新后保持。
3. 停用扩展并刷新：原生选择器重新出现，最后的原生选择仍可使用。
4. 重新启用，选择 `mock/echo`（带 OMTP 徽章）：`custom_url` 为 `http://127.0.0.1:4100/v1`，`custom_model` 为 `mock/echo`，并设置了 Bearer 头。
5. 发送 `ping`，收到 `pong`。
6. 关闭再打开 **隐藏原生 API 选择器**，刷新后状态保持。
7. 收藏一个模型，放入快捷槽位，用 `Alt+1` 切换。
8. 把模型绑定到聊天，切换聊天后绑定生效。再绑定角色，确认聊天绑定优先。
9. 设置推理强度 `high`：`#openai_reasoning_effort` 与请求体中都是该值。
10. 设置附加请求体 `{"top_k":42}`，模拟服务收到该字段。再试 `{"model":"x"}`，受保护的字段被拒绝或移除。
11. 打开 `#API-status-top`：原生密钥、服务商区块、连接按钮、连接档案、`/api` 与 `/model` 仍可用。
12. 分别用本地文件 URL 和无效 URL 刷新目录：前者成功，后者失败且保留原目录。
13. 处于网关模式时停用扩展：Custom OpenAI 恢复为进入网关模式前的设置。

### 网关

```bash
curl -s http://127.0.0.1:4100/health
TOKEN=$(cat SillyTavern/data/omtp/gateway-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:4100/v1/models
curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}],"stream":false}' \
  http://127.0.0.1:4100/v1/chat/completions
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4100/v1/models   # 未带令牌，应为 401
```

`gateway-token` 位于 `<SillyTavern 数据目录>/omtp/`；数据目录不是默认的 `data/` 时相应调整路径。
