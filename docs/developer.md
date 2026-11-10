[English](./developer.en.md) | 简体中文 | [返回 README](../README.md)

# 开发者 API

本文面向在 SillyTavern 中编写扩展或脚本、需要调用 OMTP 的开发者。参与 OMTP 本身的开发请看 [贡献指南](../CONTRIBUTING.md)。

## `globalThis.OMTP`

扩展启用后，OMTP 在全局对象上挂载 `OMTP`；扩展停用时，如果 `globalThis.OMTP` 仍是 OMTP 挂载的对象，就把它移除，并恢复挂载前的值。

| 成员 | 签名 | 说明 |
|---|---|---|
| `version` | `string` | 扩展版本，与 `manifest.json` 相同 |
| `open` | `(options?) => void` | 打开面板。`options.tab` 可为 `all`、`favorites`、`recent`、`profiles`、`providers`、`usage`、`about` |
| `close` | `() => void` | 关闭面板 |
| `toggle` | `() => void` | 切换面板开合 |
| `getCurrentSelection` | `() => EntryRef \| null` | 当前选中的模型 |
| `switchTo` | `(selectorOrRef, { persist = true }?) => Promise<EntryRef>` | 切换模型，见下文 |
| `registerProviderAdapter` | `(adapter) => object` | 注册一个 SillyTavern 原生来源的适配器 |
| `registerCatalogProvider` | `(overlay) => catalog` | 把服务商合并进当前目录，返回合并后的目录 |
| `on` | `(event, handler) => () => void` | 订阅事件，返回取消订阅函数 |
| `off` | `(event, handler) => void` | 取消订阅 |
| `events` | `{ SELECTION_CHANGED, CATALOG_CHANGED }` | 事件名常量 |
| `roles` | `{}` | 预留，目前未使用 |

### EntryRef

模型的引用，形如：

```js
{ kind: 'st', provider: 'anthropic', model: 'claude-opus-5-5' }
```

| `kind` | 含义 |
|---|---|
| `st` | 由 SillyTavern 原生来源调用（面板中的「原生」「转换」徽章） |
| `omp` | 经 OMTP 网关调用 |
| `profile` | SillyTavern 连接档案，`model` 为档案名 |

它的字符串形式是 `kind/provider/model`，如 `st/anthropic/claude-opus-5-5`。同一个模型的 `kind` 会随连接方式变化，比较两个引用时用 `provider` 与 `model`。

### switchTo

```js
// 切换并保存为默认（等同于 /model）
await OMTP.switchTo('anthropic/claude-opus-5-5:high');

// 只在本次会话切换（等同于 /switch）
await OMTP.switchTo('@1', { persist: false });

// 传入 EntryRef，或其字符串形式
await OMTP.switchTo({ kind: 'omp', provider: 'mock', model: 'echo' });
await OMTP.switchTo('omp/mock/echo');
```

- 参数可以是[选择器](#选择器语法)、EntryRef、带 `ref` 字段的对象，或 `kind/provider/model` 字符串。
- 返回最终使用的 EntryRef。选择器模糊匹配到多个模型时，返回值带 `warning` 字段说明选了哪一个。
- 模型不存在或不可用（缺少凭据、网关未运行、服务商不支持）时抛出错误。

### 事件

```js
const off = OMTP.on(OMTP.events.SELECTION_CHANGED, ({ ref, entry, gateway, reason }) => {
    console.log(`${ref.provider}/${ref.model}`, gateway ? 'via gateway' : 'native', reason);
});
// 不再需要时
off();
```

| 事件 | 名称 | 载荷 |
|---|---|---|
| `SELECTION_CHANGED` | `omtp:selection-changed` | `{ ref, entry, gateway, reason }`。`gateway` 表示是否经网关，`reason` 为触发来源（如 `public-api`） |
| `CATALOG_CHANGED` | `omtp:catalog-changed` | `{ source }`，如 `runtime`、`adapter` |

事件经 SillyTavern 的 `eventSource` 派发。`SELECTION_CHANGED` 派发时，推理强度已经写入 SillyTavern 设置。

### registerCatalogProvider

接受单个服务商、服务商映射或完整目录，按服务商 ID 合并到当前目录：同名字段以新值为准，模型按 `id` 合并。合并只存在于当前页面，刷新后消失。

```js
OMTP.registerCatalogProvider({
    id: 'my-provider',
    label: 'My Provider',
    models: [{ id: 'my-model', name: 'My Model', kind: 'chat' }],
});
```

想让网关转发新的服务商，应在面板的 **登录 → 添加自定义服务商** 中添加，或调用 `POST /providers/:id/config`；`registerCatalogProvider` 只影响前端的模型列表。

### registerProviderAdapter

注册一个描述 SillyTavern 原生来源的适配器对象，必须有唯一的 `key`。字段与 `src/adapters/native.js` 中 `createAdapter` 的参数相同（`label`、`mainApi`、`source`、`modelControl`、`modelField`、`supportsModel` 等）。注册后会触发 `CATALOG_CHANGED`。

## 选择器语法

选择器用于 `OMTP.switchTo()`、`/model` 与 `/switch`。面板顶部的搜索框只做关键词过滤，不解析选择器。

| 形式 | 规则 | 示例 |
|---|---|---|
| `provider/model` | 在第一个 `/` 处拆分；前半部分必须是已知的服务商 ID（不区分大小写），否则整个字符串按关键词处理。模型 ID 可以继续包含 `/` | `anthropic/claude-opus-5-5`、`openrouter/deepseek/deepseek-v4.1-flash-1017` |
| `@1` … `@9` | 快捷槽位。槽位为空或模型不可用时报错 | `@3` |
| `@fav`、`@favorites` | 收藏中第一个可用的模型 | `@fav` |
| `@recent`、`@recents` | 最近使用中第一个可用的模型 | `@recent` |
| `:level` 后缀 | 推理强度：`auto`、`min`、`low`、`medium`、`high`、`max`。如果整个字符串本身就是某个模型的 ID（ID 中含冒号），不拆分 | `@1:medium` |
| 其他 | 先找完整条目键或完全相同的模型 ID；找不到时模糊匹配，优先级为：完整 `provider/model` 相同 → 模型 ID 相同 → 收藏 → 最近 → 其余子串匹配 | `gemini-4-argon` |

模糊匹配到多个结果时取第一个，并在返回值的 `warning` 中说明。

## 从脚本调用插件接口

插件接口的完整列表见 [服务端插件参考](./gateway.md#管理接口)。在 SillyTavern 页面内调用时，在 SillyTavern 的请求头之外加上 `x-omtp-client`：

```js
const { getRequestHeaders } = SillyTavern.getContext();

const res = await fetch('/api/plugins/omtp/providers', {
    headers: { ...getRequestHeaders(), 'x-omtp-client': 'omtp-web' },
});
const { providers } = await res.json();
```

缺少该头时返回 403 `untrusted_client`。

网关没有设置 CORS 响应头，浏览器页面不能直接调用它；页面内的代码应通过 SillyTavern 的 Custom OpenAI 连接使用网关。从本机的其他程序调用时带上网关令牌（文件 `data/omtp/gateway-token`，或 `GET /api/plugins/omtp/gateway/token`）：

```bash
TOKEN=$(cat SillyTavern/data/omtp/gateway-token)
curl -s http://127.0.0.1:4100/v1/chat/completions \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"model":"mock/echo","messages":[{"role":"user","content":"ping"}]}'
```

网关的实际端口以 `GET /api/plugins/omtp/status` 返回的为准。
