[English](./developer.en.md) | [简体中文](./developer.md) | [返回首页 / Back to README](../README.md)

# 开发者 API、选择器与构建指南 / Developer Guide

本文档面向第三方 SillyTavern 扩展开发者、酒馆脚本作者与本仓库维护者，涵盖 `globalThis.OMTP` API、选择器语法、目录离线构建与本地沙箱调试。

---

## 1. 全局 API (`globalThis.OMTP`)

扩展启用期间，OMTP 会在全局挂载 `globalThis.OMTP`（禁用或卸载时若仍指向本实例则安全卸载）：

| 成员 | 类型 / 签名 | 说明 |
|---|---|---|
| `version` | `string` | 当前扩展版本号（与 `manifest.json` 一致） |
| `open(options?)` | `Function` | 打开模型中心面板（可传 `{ tab: 'all' \| 'favorites' \| 'recent' \| 'profiles' \| 'providers' \| 'usage' \| 'about' }`） |
| `close()` | `Function` | 关闭模型中心面板 |
| `toggle()` | `Function` | 切换面板开合状态 |
| `getCurrentSelection()` | `() => EntryRef \| null` | 返回当前激活的 `EntryRef`（`{ kind, provider, model }`），**而非**完整目录条目对象 |
| `switchTo(selectorOrRef, { persist = true })` | `async (string\|object, object?) => EntryRef` | 解析选择器字符串或 `EntryRef` 并执行切换（`persist: false` 为仅当前会话临时切换），返回 `EntryRef`；若模糊匹配命中多个模型，返回对象会附带 `warning` 字段 |
| `registerProviderAdapter(adapter)` | `(object) => object` | 运行时注册自定义 SillyTavern 原生适配器（需包含唯一 `key`），自动触发 `omtp:catalog-changed` |
| `registerCatalogProvider(provider)` | `(object) => object` | 运行时合并新增或覆盖目录服务商，返回合并后的完整目录并触发 `omtp:catalog-changed` |
| `on(event, handler)` | `(string, Function) => () => void` | 订阅事件，返回取消订阅函数 |
| `off(event, handler)` | `(string, Function) => void` | 取消事件订阅 |
| `events` | `{ SELECTION_CHANGED, CATALOG_CHANGED }` | 事件名常量（`'omtp:selection-changed'`、`'omtp:catalog-changed'`） |
| `roles` | `object` | 预留角色扩展命名空间 |

### 代码示例

```javascript
// 1. 切换模型并持久化为默认选择
await OMTP.switchTo('anthropic/claude-opus-5-5:high');

// 2. 仅在当前会话临时切换（等同于 /switch）
await OMTP.switchTo('@1', { persist: false });
await OMTP.switchTo('@fav');

// 3. 读取当前选择引用
const ref = OMTP.getCurrentSelection();
// => { kind: 'st', provider: 'anthropic', model: 'claude-opus-5-5' }

// 4. 监听模型切换事件（注意：推理强度已在事件派发前写入完毕）
const unsubscribe = OMTP.on(OMTP.events.SELECTION_CHANGED, ({ ref, entry, gateway, reason }) => {
    console.log(`[OMTP] switched to ${ref.provider}/${ref.model} (gateway=${gateway}, reason=${reason})`);
});
```

---

## 2. 选择器语法 (`resolveSelector`)

选择器语法用于 `OMTP.switchTo()`、`/model` 与 `/switch` 斜杠命令（面板顶部的搜索框直接做关键词模糊过滤，不解析 `@` 语法）：

| 语法形式 | 解析规则 | 示例 |
|---|---|---|
| `provider/model` | 以**第一个** `/` 切分服务商与模型 ID，模型 ID 自身可继续包含 `/` | `anthropic/claude-opus-5-5`<br/>`openrouter/deepseek/deepseek-v4.1-flash-1017` |
| `@1` .. `@9` | 对应面板顶部的 1–9 号快速槽位（若槽位为空或目标模型当前不可用则报错） | `@1`、`@3` |
| `@fav` / `@favorites` | 按顺序取收藏夹中**第一个当前可用**（`available !== false`）的模型 | `@fav` |
| `@recent` / `@recents` | 按顺序取最近使用列表中**第一个当前可用**的模型 | `@recent` |
| `:level` 后缀 | 在任意选择器末尾追加 `:auto` / `:min` / `:low` / `:medium` / `:high` / `:max` | `claude-opus-5-5:high`<br/>`@1:medium` |
| 裸模型 ID / 关键词 | 先匹配完整 `key` 或精确 `model` ID，再按收藏 > 最近 > 子串位置排序 | `gemini-4-argon` |

---

## 3. 目录构建与 AA-PersonalityBench 同步

内置目录包含 **99 家服务商、5,770 个聊天模型**（仅保留 `kind: 'chat'`，剔除图像/语音/嵌入模型）与 **41 个模型**的 AA-PersonalityBench 八维人格评分快照。

```bash
# 1. 从本地 oh-my-pi 仓库重新生成双副本目录（默认读取 ~/oh-my-pi）
npm run catalog -- --omp-root /path/to/oh-my-pi

# 2. 校验两份目录 JSON 的结构、服务商/模型数量、44 个原生适配器映射及双副本字节一致性
npm run validate

# 3. 重新抓取并计算 catalog/personality.json（页面缓存于 .cache/）
npm run personality

# 4. 仅校验人格指数推导算法与官方已发布分数的最大偏差（不改写文件）
npm run personality:verify
```

> **为什么仓库里有两份完全相同的 `omtp-catalog.json`？**
> `catalog/omtp-catalog.json` 供前端扩展直接加载，而 `server-plugin/catalog/omtp-catalog.json` 随服务端插件独立复制到 `SillyTavern/plugins/omtp/`。`tools/build-catalog.mjs` 会同时写入两处，`tools/validate-catalog.mjs` 会强制校验两份文件字节完全一致。

---

## 4. 单元测试与本地零成本 Mock 调试

```bash
# 运行全部单元测试（Node.js 原生 test runner）
npm test

# 启动本地 OpenAI 兼容 Mock 上游服务（监听 http://127.0.0.1:4199/v1）
npm run mock
```

**使用 Mock 服务在酒馆内免 Key 联调网关**：
1. 终端运行 `npm run mock`（提供 `echo` 模型，收到含 `ping` 的消息会回复 `pong`，其余回复 `echo: ...`，支持流式 SSE）。
2. 打开 OMTP 面板 → 切换到 **登录 (Sign-in)** 标签页 → 点击底部的 **添加自定义服务商 (Add custom provider)**：
   - **ID**：`mock`
   - **Adapter**：`openai`
   - **Base URL**：`http://127.0.0.1:4199/v1`
   - **Models JSON**：`echo`
   - **API key**：任意非空字符（如 `x`）
3. 回到 **全部 (All)** 标签页选中 `mock/echo` 发送消息，即可验证网关转发、流式计费与 Extra Body 注入。完整端到端手工检查清单见 [`tests/e2e/README.md`](../tests/e2e/README.md)。

## 5. 实时模型列表的本地缓存

点击服务商旁的 `🔄`（或打开服务商时后台探测）会请求 `GET /api/plugins/omtp/providers/:id/models`。探测成功后，服务端插件把结果写入数据目录 `data/omtp/live-models.json`（`0600`），文件不包含任何密钥：

```json
{
  "version": 1,
  "providers": {
    "<providerId>": { "at": 1793942451762, "models": [{ "id": "gpt-x", "name": "GPT X" }] }
  }
}
```

- **写入时机**：仅当探测成功且返回非空列表时写入；失败的刷新不会清空磁盘上的上次结果。更换/删除密钥、修改或删除服务商配置、退出登录或导入 OMP 凭据时，会移除对应服务商的缓存条目；在此期间仍在进行的探测结果不会写入缓存。
- **启动加载**：`createState()` 通过 `server-plugin/lib/live-models-store.mjs` 的 `loadLiveModels(root)` 把仍在新鲜期（5 分钟）内的磁盘条目注入内存缓存，因此重启酒馆后无需重新请求上游。过期条目在读取时丢弃。
- **新鲜度**：5 分钟内（`LIVE_MODELS_TTL`）的结果直接命中、不再请求；超过 5 分钟一律重新探测。**没有回退**：探测失败时接口返回 `ok: false` 与错误信息，绝不会把过期列表当成可用结果返回，避免用户选中上游已下架的模型；`?refresh=true` 同样直接返回真实结果或错误。
- **前端缓存**：`src/catalog.js` 按服务端返回的探测时间 `at` 计算 5 分钟有效期（不会把服务端缓存再续 5 分钟）；探测失败、保存/删除密钥、退出登录或登录完成时丢弃该服务商的列表，界面回退到内置目录的模型。
- **容量与容错**：最多保留 128 家服务商（`LIVE_MODELS_MAX_PROVIDERS`，按最近探测时间裁剪），超出新鲜期的条目在读写时丢弃；文件缺失、损坏或版本不符时按空缓存启动。
- **隐私**：只缓存模型 id 与元数据，不缓存密钥。逻辑位于 `server-plugin/lib/live-models-store.mjs`，由 `tests/unit/live-models-store.test.mjs` 覆盖。


## 附：直接调用插件 HTTP 接口

服务端插件挂载在 `/api/plugins/omtp/*`。除 `globalThis.OMTP` 的封装外，所有请求都必须同时携带 SillyTavern 的认证头与 `x-omtp-client: omtp-web`，否则返回 403：

```js
const res = await fetch('/api/plugins/omtp/status', {
  headers: { ...getRequestHeaders(), 'x-omtp-client': 'omtp-web' },
});
```
