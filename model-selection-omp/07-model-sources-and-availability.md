# 模型来源与可用性

选择算法的输入是"当前可见的模型集合"。这个集合由 `ModelRegistry` 合成，不是单一 catalog。移植时必须把"模型从哪来"和"用户选哪个"分开，否则会把认证、发现、覆盖逻辑塞进解析器。

## 1. 五个来源

```text
built-in catalog (packages/catalog/src/models.json)
  + models.yml 自定义 provider / model / overrides
  + models.db 运行时发现缓存
  + 运行时发现（配置式 discovery + 扩展 fetchDynamicModels）
  + 扩展 registerProvider 覆盖
  → 不可变快照 → getAll(kind) / getAvailable(kind) / find(provider, id)
```

合并优先级（同一 `provider/id`，高 → 低）：

1. 运行时扩展覆盖（`registerProvider` 的 provider override / model overlay）。
2. `models.yml` 自定义模型（同 id 用 replace 补丁，transport 整体由自定义拥有）。
3. 运行时发现结果。
4. `models.db` 启动缓存。
5. 内置 catalog。

`models.yml` 的每种字段合并规则不同：

- `modelOverrides`：`undefined` 保留原值，显式字段覆盖（cost/contextWindow/maxTokens 等）。
- `compat`：递归深合并。
- `baseUrl`：用户 provider override > 发现到的 baseUrl > 内置；`transport: pi-native` 时 provider 级无条件生效。
- `kind`：配置的 kind 优先于 catalog 分类；但必须被最终 api 支持，否则忽略并告警。

## 2. 可用性判定

```ts
available(provider) =
  !disabledProviders.has(provider) &&
  (keylessProviders.has(provider) ||
   authStorage.keys.source(provider) !== undefined ||
   authStorage.keys.keyless(provider))
```

要点：

- **这是 provider 级判定**，不是模型级。provider 可用，其所有 kind 的模型都进入候选。
- `getAvailable()` 默认只返回 `kind === "chat"`；`getAvailable("all")` 用于角色池，再由 role 的 `accepts` 谓词过滤。
- `enabledModels` **不在这里**。它由 `resolveAllowedModels` / `filterAvailableModelsByEnabledPatterns` / `ModelControls.getAvailableModels` 在上层应用。
- `hasConfiguredAuth(model)` 是请求前门禁，额外支持 env aliases（例如 `xai-oauth` 借用 `XAI_API_KEY`），但不刷新 OAuth、不执行 `!cmd`。
- `hasConcreteAuth(provider)` 要求凭据来源是具体的（非环境哨兵），只用于自动挑选默认模型。

这三者不要合并：

| 概念 | 回答的问题 |
|---|---|
| `available` | 这个 provider 现在能用吗？ |
| `hasConfiguredAuth` | 这个模型现在能发请求吗？ |
| `enabledModels` | 用户允许我在哪些模型里选？ |

## 3. 模型 kind

`MODEL_KINDS`：`chat`、`tiny`、`image`、`tts`、`stt`、`search`、`judge`、`embedding`、`rerank`、`video`。

- `modelKind(model) = model.kind ?? "chat"`。
- 角色通过 `accepts` 谓词限制候选池：
  - `default/smol/slow/vision/plan/commit/task/advisor/widget` → `chat`
  - `tiny` / `memory` → `tiny` 或 `chat`
  - `image` → `image`
  - `web` → `search` 或带 `webSearch` 的 chat
  - `speech` → `tts`；`dictation` → `stt`
  - `judge` → `judge` / `tiny` / `chat`
- 同一个 provider 可以同时提供多种 kind；选择时不要只按 provider 过滤。

## 4. 刷新与缓存

- `refresh(strategy)`：`online` / `offline` / `online-if-uncached`。
- 静态层用 `models.yml` 的 mtime 门控；`force` 才清空 override/discovery 状态重载。
- 发现层用 `models.db` 的 `model_cache` 表；TTL 按 provider/发现类型不同（启动缓存 24h，内置 manager 默认 2h 等）。
- `refreshCommandCredentials` 是独立开关：只有显式用户刷新才重新执行 `!cmd` 凭据。
- 发现状态：`idle | ok | empty | cached | unavailable | unauthenticated`；401/403 归为 `unauthenticated`。
- `getError()` 只反映 `models.yml` 加载失败；失败时 custom 层整体作废，只剩内置 catalog。

移植时如果不需要在线发现，可以只保留"静态来源 + 手动刷新"，但必须保留：

- 可用性谓词；
- `find(provider, id)` 的精确查找；
- kind 过滤；
- 刷新后快照替换（不要原地改数组，避免读到半更新状态）。

## 5. 与选择器的边界

Registry 只负责"给我全部/可用/按 id 查找"，**不做模糊匹配、不解析角色、不读用户偏好**。这些都在 resolver。

一个常见的错误设计是让 registry 接受 `"opus"` 并返回"最像的模型"。OMP 刻意把模糊匹配放在 resolver，因为：

- 同一份 catalog 在不同作用域（scoped / available）下匹配结果不同；
- MRU、provider 顺序是用户偏好，不属于模型来源；
- provider 锁定（`anthropic/x` 不能静默绑定到 OpenRouter 的同名 id）是选择语义，不是查找语义。

## 6. 移植最小实现

```ts
interface ModelRegistry {
  getAll(kind?: ModelKind | "all"): Model[];
  getAvailable(kind?: ModelKind | "all"): Model[];
  find(provider: string, id: string): Model | undefined;
  hasConfiguredAuth(model: Model): boolean;
  hasConcreteAuth(provider: string): boolean;
  getProviderOrder(): string[];
  refresh(): Promise<void>;
}
```

内部至少维护：

- `models: Model[]`（不可变快照）；
- `disabledProviders: Set<string>`（来自配置，刷新时重读）；
- `authSource(provider)` / `keyless(provider)`；
- `kind` 索引（`Map<ModelKind, Model[]>`）；
- 可选的发现缓存与 TTL。

## 7. 不要做的事

- 不要在 registry 里应用 `enabledModels`：那会让"白名单为空"与"没有模型"无法区分。
- 不要把 `enabledProviders` 当作模型 allow-list。
- 不要在可用性判定里执行网络请求或 OAuth 刷新；请求前的凭据解析应单独一层。
- 不要原地修改 `models` 数组；解析过程可能持有快照。
- 不要把 `modelPerf` 当作选择依据；它只影响展示。
