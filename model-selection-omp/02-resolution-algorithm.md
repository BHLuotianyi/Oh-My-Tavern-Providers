# 解析算法：从字符串到模型

本文描述 `packages/coding-agent/src/config/model-resolver.ts` 的完整决策过程。核心只有一条流水线：

```
selector 字符串
  → 词法切分（provider/id、:level、@upstream）
  → matchModel 匹配（精确 → 别名 → 模糊 → 子串）
  → 偏好排序（MRU / provider 顺序 / 注册顺序）
  → 角色展开（如果输入是 @role 或角色值）
  → 按顺序尝试候选
  → ResolvedModelRoleValue { model?, thinkingLevel?, explicitThinkingLevel, warning }
```

## 1. 入口函数对照

| 场景 | 函数 |
|---|---|
| 解析单个 pattern | `parseModelPattern` / `resolveModelFromString` |
| 解析角色值或有序链 | `resolveModelRoleValue` |
| 解析角色并保留当前模型回退 | `resolveRoleModelFull`（`session/role-models.ts`） |
| 解析 CLI flag / `/model` / `/switch` 选择器 | `resolveCliModel` |
| 解析启动作用域 | `resolveModelScope` / `resolveAllowedModels` |
| 解析 fallback 链候选 | `resolveRoleChain` / `resolveRetryFallbackChainKey` |
| 仅做可用性过滤 | `filterAvailableModelsByEnabledPatterns` |

## 2. 匹配引擎 `matchModel`

实现位置：`model-resolver.ts:740-872`。按固定顺序，**前一步命中就返回**。

### 2.1 精确 `provider/id` 引用

`findExactModelReferenceMatch` → `resolveProviderModelReference`（`:429-503`）。这一步不只是"查表"：

1. 在 `provider\0id` 小写索引中查；如果同一 key 对应多行，返回 `null` 哨兵，结果是**不匹配**，不会随便挑一个。
2. 变体别名：手写表 `resolveVariantSelector`，再尝试 `X-thinking` → `X` 的语法回退。
3. 思考路由反向索引：`model.thinking.effortRouting` 里的 wire id 可反查逻辑模型；多个级别共享同一 wire id 时不推断。
4. Bedrock inference profile ARN 生成合成模型。
5. 点号/短横线版本拼写互认（`claude-opus-4-8` ↔ `claude-opus-4.8`），且只在指定 provider 内回退。
6. 仅 OpenRouter：剥离 `:route` 后缀与 `-YYYYMMDD` 日期，克隆成请求的 id。

### 2.2 精确裸 id

大小写不敏感的 `id` 全等匹配（`:786-803`）。这里有一条关键的 **provider 锁定**规则：如果 pattern 是 `provider/id`，而该 provider 的 catalog 中确实有这个 id，那么即使别的 provider 也有同 id，也不能跨 provider 绑定（`isProviderLockedCrossMatch`，`:678-705`）。用户自定义、无内置 catalog 的 provider 例外。

多个精确匹配时用 `pickPreferredModel` 排序（见 §4）。

### 2.3 已退役的变体别名

`resolveBareVariantSelector` / `stripThinkingVariantSuffix`（`:810-821`）。例如旧的 effort 分层 id 折叠回逻辑模型；provider 自己声明过的别名优先。

### 2.4 provider 内模糊

pattern 含 `/` 且前缀是已知 provider 时：

- 对 `model.id` 做 `fuzzyMatch`（`packages/tui/src/fuzzy.ts`，分数越小越好）。
- 如果 id 里带 `@upstream` 且该 provider 支持路由，则**放弃模糊**，交给路由重试，避免把 `@cerebras` 当 id 的一部分吃掉。
- 排序：fuzzy 分数 → 模型 MRU → provider MRU → 注册顺序（`:849-860`）。
- 前缀不是已知 provider 时，把 `/` 当作 id 的一部分继续通用匹配。

### 2.5 子串与版本

- 匹配 `id` 或 `name` 包含 pattern（大小写不敏感）。
- 别名（`-latest` 或无 `-YYYYMMDD` 日期）优先。
- 没有别名但只有一个日期版本 → 直接返回。
- 多个日期版本 → 取 id 字典序最大的那个（最新），再在同 id 内用偏好排序。

### 2.6 无匹配

返回 `undefined`，由上层决定告警或错误。

## 3. 可用性与作用域过滤

这三层必须分清：

| 层 | 判定 | 代码 |
|---|---|---|
| 注册表可用 | provider 未禁用 **且**（keyless 或 auth source 存在） | `model-registry.ts:3016-3033` |
| 凭据门禁 | `hasConfiguredAuth(model)`：按 provider 查 key/env/aliases，不刷新 OAuth、不执行 `!cmd` | `model-registry.ts:3095-3106` |
| 白名单作用域 | `enabledModels` / `--models` 的 glob 或精确选择器 | `resolveAllowedModels`、`resolveModelScope`、`filterAvailableModelsByEnabledPatterns` |

补充：

- `hasConcreteAuth(provider)` 要求凭据来源是"具体"的，用来避免 Bedrock/Vertex 的环境哨兵抢走启动默认。
- `enabledProviders` **不是**模型 allow-list；它只控制外部配置源（Claude/Codex/Gemini 用户级文件等）的发现。
- `disabledProviders` 在 `resolveCliModel` 中会先于匹配过滤；如果选择器指向被禁用的 provider，返回明确错误而不是静默换模型（`model-resolver.ts:2108-2144`）。
- `getAvailable()` 默认只返回 `kind === "chat"`；角色池用 `getAvailable("all")` 再按 `accepts` 谓词筛选（`model-roles.ts:100-103`）。
- `enabledModels` 形成的 scope 只限制 **chat** 模型（启动模型、Ctrl+P 循环、chat 角色）；`judge`、`search`、`image`、`speech` 等 kind 角色仍可独立解析。因此把非 chat 模型写进 `enabledModels` 不会报错，但没有作用。

## 4. 偏好排序 `pickPreferredModel`

实现：`model-resolver.ts:590-625`。顺序固定：

1. **模型 MRU**：`settings.getStorage().getModelUsageOrder()` 中的 `provider/id` 排名。
2. **provider 优先级**：`modelProviderOrder` 配置项优先，其后是内置 catalog 的 provider 顺序。
3. **provider MRU**：最近使用模型的 provider。
4. **`deprioritizeProviders`**：显式降权的 provider 排最后。
5. **注册表顺序**：`availableModels` 的数组顺序。

`modelPerf`（TPS/TTFT）只用于 UI 展示，**不参与**解析（`session/agent-storage.ts` 的 `model_perf` 表，`model-browser-source.ts:51-53`）。

## 5. 角色展开与默认链

角色值不是简单的"替换成字符串"，而是有优先级的展开。

### 5.1 展开算法

`resolveConfiguredRolePattern`（`:1194-1244`）对每个 pattern：

1. 不是角色别名 → 原样保留（模糊片段如 `-mini` 直接进入匹配器）。
2. 是角色别名 → 取角色 `r`，用 `visited` 防环。
3. 按以下顺序找值：
   1. `settings.getModelRole(r)`（允许逗号链）→ 递归展开嵌套角色。
   2. `ROLE_CONFIGURED_FALLBACK[r]`：`advisor → slow`（仅当 slow 已配置）、`memory → tiny`、`tiny → smol`、`widget → smol`。
   3. 仅 `smol` / `slow`：若配置了 `modelRoles.default`，把它**前置**到内置链之前。
   4. 内置链 `rolePriorityDefaults(r)`。
4. 结果为空 → 用内置链；仍为空 → `undefined`（例如未配置的 `@default`）。
5. 角色别名上的 `:level` 追加到**每个**展开结果。

`resolveNestedRolePatterns`（`:1150-1181`）处理嵌套别名；遇到环时用当前角色的内置链替代，不递归爆栈。

### 5.2 内置链来源

内置链不是 TS 常量，而是由 `packages/catalog/src/compat/rules/runtime/behavior.kdl:386-494` 的 `role-defaults` 声明，经 `gen:compat` 编译，运行时通过 `roleDefaultModels()` 读取。

| 角色 | 默认行为 |
|---|---|
| `default` | 无内置链；未配置时交给自动挑选 |
| `smol` | 一长串快速模型（Haiku → Gemini Flash → Codex Spark → GLM Flash → … → `-mini`） |
| `slow` | 一长串强模型（GPT-5.6 Sol → Claude Fable/Opus → Kimi K3 → GLM → …） |
| `vision` / `plan` / `commit` / `task` | 无内置链，由调用方回退或继承会话模型 |
| `tiny` | 先配置的 `smol`，否则 `smol` 链 |
| `memory` | 先配置的 `tiny`，否则 `smol` 链 |
| `advisor` | 先配置的 `slow`，否则 `slow` 链（不会拿未配置的主模型） |
| `widget` | 同 `smol` |
| `judge` | TypeSafe Jev → OpenRouter Jev → `@tiny` → `@smol` → `@default` |
| `image` / `web` / `speech` / `dictation` | 各自的 kind 链 |

注意 `smol` / `slow` 的"先继承 default"是刻意设计：用户只配置了 `default` 时，快速/思考角色默认跟随主模型，而不是落到一个不相干的模型。

### 5.3 `resolveModelRoleValue` 的最终语义

`model-resolver.ts:1431-1477`：

- 空值、空白、字面 `"default"` → `{ model: undefined, ... }`。
- 展开成 pattern 列表；逐个用 `matchPatternWithContext` 匹配。
- 第一个命中的 pattern 返回：
  - `model`
  - `matchedPatternIndex`
  - `thinkingLevel`：显式级别会被**钳制到模型支持的档位**；`auto` 原样保留；非显式级别为 `undefined`。
  - `explicitThinkingLevel`
  - 第一个失败 pattern 产生的 `warning`。
- 全部失败 → `{ model: undefined, warning? }`。

这里的 `warning` 专门用于"thinking 后缀非法"这类非致命问题；调用方决定是否展示（TUI `/switch` 会展示，ACP 不展示）。

## 6. 自动挑选 `pickDefaultAvailableModel`

实现：`:88-135`。用于"没有任何显式模型"时的兜底：

1. 过滤 `automaticDefault === false` 的 provider（这些 provider 只能被显式选择）。
2. 若提供 `hasConcreteCredential` 且存在具体凭据的 provider，候选池先收窄到这些 provider。避免 AWS/Vertex 的"环境凭据"压过用户真正登录的 provider。
3. 优先 `isProviderDefault`；否则用 `DEFAULT_MODEL_PER_PROVIDER[provider]`。
4. 多个 provider 有同名默认模型时，按内置 provider 优先级排序（原生/OAuth 优先于镜像）。
5. 都没有 → 取候选池第一个。

## 7. 启动时的初始模型

真实顺序（`main.ts:1479-1600` + `sdk.ts:2025-2155`）：

1. **`--model`**：`resolveCliModel` 解析；成功后写入 `options.model`，并把 `modelRoles.default` 以**运行时覆盖**方式设为该选择器（含 `:level`），不落盘。
2. **作用域**（无 `--model`、有 `--models`/`enabledModels`、且不是恢复会话）：
   - 配置的 `default` 若能在作用域内解析 → 用它；
   - 配置了 `default` 但在作用域内解析不到、且作用域来自 settings → **延迟**到扩展注册后再解析，避免把 default 错误地固定成无关模型；
   - 其余情况（没有配置 `default`，或作用域来自 CLI `--models`）→ 取作用域第一个模型。
3. **会话恢复**（无显式模型且有历史会话）：按 `getRestorableSessionModels` 候选顺序恢复；每个候选都要求凭据可用。
4. **`modelRoles.default`**：在 `allowedModels` 内解析。
5. **provider 默认 / 首个可用**：`pickDefaultAvailableModel`，扩展注册后会再尝试一次。

`--thinking` 的优先级独立且最高；其后依次是会话日志、恢复模型的后缀、`default` 角色后缀、模型 `thinking.defaultLevel`、全局 `defaultThinkingLevel`（`sdk.ts:2120-2155`）。

## 8. CLI 选择器 `resolveCliModel`

`model-resolver.ts:2108-2320`。规则：

1. 过滤 `disabledProviders` 后的作用域内解析。
2. 无 `--provider` 时：
   - 精确 `provider/id`；
   - 精确 `provider/id:level`（先切后缀再精确）；
   - 角色：`@role` / `pi/role` / `*`，或裸名且 `settings.getModelRole(name)` 存在；
   - 否则走模糊/目录回退。
3. 有 `--provider`：先校验 provider 存在，再在该 provider 内匹配。
4. 优先级：显式 `provider/id` / 已认证裸 id > 配置角色 > 未认证的 catalog-only id。这样内置的 `cursor/default` 不会盖过用户配置的 `modelRoles.default`。
5. 失败信息区分：
   - `No models available...`
   - `Unknown provider "x"...`
   - `Model "x" not found...`
   - `Provider "x" is disabled. Remove "x" from disabledProviders to use "y".`

返回结构 `ResolveCliModelResult` 同时带 `configuredPatterns` / `configuredRole` / `warning` / `error` / `disabledProvider`。**注意**：`/model` 与 `/switch` 会丢弃 `error`，只显示 `Unknown model: ...`；`/prewalk` 才会展示具体原因。

## 9. 回退链解析

`retry.fallbackChains` 的解析在 `session/retry-fallback-chains.ts`：

- key 选择顺序：精确模型 key（含 effort）→ 去掉 effort 的模型 key → 去掉后缀的 base key → 最长匹配的 wildcard（带 id 前缀优先）→ 角色 key（`default` 优先）→ `default` 链。
- `getRetryFallbackChains` 会把 `default` 链应用到所有具名角色（`default` 与 kind 角色除外）；显式 `[]` 表示禁用。
- 每个候选仍走 `resolveModelRoleValue`，因此角色/模糊/`:level` 语法一致。
- 候选去重键是 `formatModelStringWithRouting(model)`。

## 10. 失败语义总结

| 场景 | 行为 |
|---|---|
| 角色值为空/`default` | 无模型，调用方回退到自动挑选 |
| 单个候选无匹配 | 尝试下一个；保留第一条 warning |
| 显式后缀非法 | 对前缀递归，返回 warning，使用默认 thinking |
| provider 被禁用 | CLI 明确报错；注册表直接不可见 |
| 无凭据 | 仍可"选中"但不参与可用集合；`setModel` 会抛 `No API key for ...` |
| 作用域为空 | `resolveAllowedModels` 返回 `[]`，表示"无可用模型"，**不会**回退到全局默认 |
| fallback 链全失败 | 保留原模型并走正常重试/报错 |

## 11. 性能与缓存

- 每次角色解析都会构建一次 `PreferenceContext`（模型顺序表），并在多个 pattern 间复用；不要在循环里反复构建。
- `getAll(kind)` / `getAvailable(kind)` 有按数组键的 WeakMap 记忆化；provider 查找有窄快照缓存。
- `getModelMatchPreferences` 读取 MRU 和 providerOrder；MRU 在每次模型切换后更新，因此解析结果可能随使用历史变化。
- 文本模糊匹配是 O(n)；大 catalog 下应尽量先做精确/角色分支。
