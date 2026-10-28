# 选择器语法

选择器（selector）是用户与配置里描述"要哪个模型"的字符串。OMP 把它拆成两层：

- **词法层**：`packages/tui/src/overlays/model-selector.ts`（103 行）。只负责切分 `provider/id`、`:thinking` 后缀、`@upstream` 路由后缀和规范化输出。
- **语义层**：`packages/coding-agent/src/config/model-resolver.ts`。负责把切出来的片段匹配到真实模型、展开角色、尝试下一个候选。

移植时建议照搬这两层分离：词法层无状态、可单测；语义层需要模型集合与偏好。

## 1. 形式总表

| 形式 | 示例 | 说明 |
|---|---|---|
| 字面 `provider/id` | `anthropic/claude-opus-5` | 第一个 `/` 之前是 provider，之后全部是 id。id 本身可含 `/` |
| 裸模型 id | `opus-5`、`claude-fable-5.1` | 先精确匹配，再 provider 内模糊，再子串 |
| 带 thinking 后缀 | `zai/glm-5.3:high`、`@smol:xhigh` | 最后一个冒号后的合法级别 |
| 上游路由 | `openrouter/z-ai/glm-4.7@cerebras` | 仅 OpenRouter / Vercel Gateway 等聚合器生效 |
| 角色别名 | `@smol`、`@task:high`、自定义 `@review` | 前缀 `@`；旧前缀 `pi/` 仍接受 |
| 默认角色简写 | `*`、`*:xhigh` | 等价于 `@default`；在 scope 里 `*` 是 glob |
| 逗号有序链 | `@commit,@smol`、`a/b:high,c/d` | 只按 `,` 分割，先解析成功者胜 |
| 作用域 glob | `openai/*`、`*sonnet*`、`provider/*:high` | 仅用于 `enabledModels` / `--models` |
| fallback 链 key | `default`、`openrouter/*`、`openai/gpt-*/*` | 仅用于 `retry.fallbackChains` |
| 上游路由 + thinking | `openrouter/z-ai/glm-4.7@cerebras:high` | `:level` 保留在 base 上，先切路由再解析 |

**不存在**：`#1`/数字下标、空格分隔的链、模型级 `auto` 别名、`profile` 通配符。`auto` 只作为 `:auto` thinking 哨兵，或本来就是字面 id（如 `synthetic-search/auto`）。

## 2. `provider/id` 的切分

```ts
// packages/tui/src/overlays/model-selector.ts:59
parseModelString("openrouter/z-ai/glm-4.7")
// -> { provider: "openrouter", id: "z-ai/glm-4.7" }
```

规则：

- `indexOf("/") <= 0` 视为无效（`/foo`、`foo` 都不算 `provider/id`）。
- provider 只取第一段，其余全部属于 id。这对 OpenRouter、Vercel Gateway、`workers-ai/@cf/...` 这类带斜杠的 id 是必要的。
- provider 与 id 的匹配都大小写不敏感；但输出规范化时保留 catalog 中的原始拼写。

## 3. thinking 后缀

词法层的优先级刻意做成"先当字面 id，再当后缀"：

```ts
// 伪代码，来自 model-selector.ts:44-78
splitThinkingSuffix(pattern, minColonIndex = -1, options?) {
  i = pattern.lastIndexOf(":")
  if (i <= minColonIndex) return { base: pattern }
  level = parseThinkingSuffix(pattern.slice(i + 1), options)
  return level ? { base: pattern.slice(0, i), level } : { base: pattern }
}
```

- 严格级别（无需额外开关）：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`inherit`。
- 宽松级别：`max`、`auto`，需要 `allowMaxSuffix` / `allowAutoAlias`。原因是真实模型 id 可能以 `:max` 结尾（例如 `glm-4.7:max`）。
- 缩写：任何级别都接受**无歧义且至少 2 字符**的前缀（`med` → `medium`、`xhi` → `xhigh`）。单字符不接受。见 `packages/tui/src/thinking.ts:70-77`。
- `parseModelString` 在切 `:max` / `:auto` 时，如果调用方提供 `isLiteralModelId` 且该完整 id 真实存在，则**保留为 id**，不切后缀。
- 语义层还会多一步：先对完整 pattern 做一次 exact-only 匹配；失败后才切后缀并递归。这样 `router:low` 这种字面 id 不会被误切，同时 `kimi-for-coding:high` 不会模糊匹配到 `kimi-for-coding-highspeed`。见 `model-resolver.ts:909-993`。

`inherit` 表示"沿用会话/模型默认"，在 `formatModelSelectorValue` 中不会被写回字符串（`model-selector.ts:81-83`）。

## 4. 上游路由 `@upstream`

```ts
// model-selector.ts:98-103
splitUpstreamRouting("openrouter/z-ai/glm-4.7@cerebras")
// -> { base: "openrouter/z-ai/glm-4.7", upstream: "cerebras" }
```

- 从最后一个 `@` 切；`@` 之后的字符串必须匹配小写 slug 路径（允许 `google-ai-studio/priority` 这类带 `/` 的 tier）。
- `:level` 留在 base 上：`...@cerebras:high` → base `...:high`。
- 只有当 base 解析出的模型支持上游路由（聚合器）时才会应用；否则 `@` 原样属于 id。`model-resolver.ts:322-341, 997-1016`。
- 结果模型会带一个路由标记，`formatModelStringWithRouting` 会把 `@upstream` 重新拼回去（`model-resolver.ts:208-212`）。

## 5. 角色别名

| 写法 | 含义 |
|---|---|
| `@smol` | 内置或已配置的角色 `smol` |
| `@review` | 仅当 `modelRoles.review` 存在（或 `modelTags.review` 注册）时才算角色 |
| `pi/smol` | 旧前缀，语义同 `@smol`；`pi/` 后不是角色时按字面 provider `pi` 处理 |
| `*` | `@default` |
| `@default` | 默认角色；未配置时**解析为无模型**，交给自动挑选 |

要点：

- 角色识别是"白名单"式的：`getModelRoleAlias` 只接受内置角色 id 或 `settings.getModelRole(candidate) !== undefined` 的角色（`model-resolver.ts:1052-1061`）。
- 裸角色名（不带 `@`）**只在 CLI 解析路径**里作为便利写法：`resolveCliModel` 发现 `settings.getModelRole(name)` 存在时，把它当作 `@name`。在 `modelRoles` 的**值**里写 `smol` 不会触发角色展开，会被当作模糊模型片段。
- `resolveModelRoleValue` 对值 `"default"` 有特殊处理：直接返回空（未配置），不会把 `default` 当模型名（`model-resolver.ts:1441-1448`）。字面模型 `cursor/default` 只能通过 `provider/id` 形式到达。

## 6. 有序链与后缀传播

- 只有 `,` 是分隔符；数组值也会被逐个元素再按 `,` 拆开。`normalizeModelPatternList` 会 trim 并丢弃空项（`model-resolver.ts:1063-1067`）。
- 角色值里的链按顺序尝试，第一个解析出模型的胜出。
- 角色别名上的 `:level` 会**传播到展开后的每一个候选**：`@judge:high` 展开成 `typesafe/jev-1.14.0:high, openrouter/...:high, @tiny:high, ...`（`model-resolver.ts:1242-1243`）。

## 7. 作用域 glob（不是通用语法）

`enabledModels` 与 `--models` 支持 glob：

- 模式同时匹配 `provider/id` 和裸 id，都会转小写（`model-resolver.ts:133-139`）。
- 支持 `*`、`?`、`[...]`（`Bun.Glob`）。
- `provider/*`、`*sonnet*` 都合法。
- `:max` 结尾的 glob 会先按字面匹配一次，失败再切后缀（`model-resolver.ts:141-180`）。
- 在 scope 上下文里，`*` 会在角色分支之前被当作 glob 处理（`model-resolver.ts:1868-1892`）。

## 8. fallback 链的 key 语法

`retry.fallbackChains` 的 key 与普通选择器不同：

- 不含 `/` → 角色 key（`default`、`smol`、`judge`）。
- 含 `/` → 模型 key（`anthropic/claude-opus-5`）。
- 以 `/*` 结尾 → 通配 key：`openrouter/*` 匹配该 provider 的所有模型；`openrouter/google/*` 匹配 id 前缀 `google`。
- 链的值是选择器数组；`provider/*` 作为**条目**时表示"保留失败模型的 id，只换 provider"（`session/retry-fallback-chains.ts:95-134, 537-563`）。

## 9. 规范化输出

- `formatModelString(model)` → `provider/id`。
- `formatModelStringWithRouting(model)` → 若模型带单一上游路由，追加 `@upstream`。
- `formatModelSelectorValue(selector, level)` → `selector:level`，`undefined` 与 `inherit` 不写。
- 角色值写回时，`formatRoleModelValue` 会保留角色原有的显式 `:level`（`session/role-models.ts:10-28`）。

## 10. 解析顺序伪代码（词法 + 模式层）

```text
resolvePattern(pattern):
  # 1. 完整 pattern 精确匹配（不做模糊）
  m = matchExactReference(pattern)
  if m:
      level = inferWireRouteLevel(pattern, m)   # 被折叠的 wire id 可能隐含级别
      return { m, level, explicit: level != nil }

  # 2. 若末尾是合法 thinking 后缀
  { base, level } = splitThinkingSuffix(pattern, allowMax, allowAuto)
  if level:
      # 2a. 模糊结果本身就带这个后缀（如 router:low）→ 当作字面 id
      literal = matchFuzzy(pattern)
      if literal.id endsWith ":" + level: return { literal, level: nil }

      # 2b. 先递归 base，避免后缀被更长的兄弟 id 吃掉
      r = resolvePattern(base)
      if r.model: return { r.model, level: explicit ? level : nil, warning: r.warning }
      return r

  # 3. 整体模糊/子串
  m = matchFuzzyOrSubstring(pattern)
  if m: return { m, explicit: false }

  # 4. 冒号但不是合法级别 → 对前缀递归并告警
  if pattern has ":":
      r = resolvePattern(prefix)
      if r.model: return { r.model, warning: "Invalid thinking level ..." }
```

`@upstream` 的重试在模式层之外：直接解析失败后，若 `splitUpstreamRouting` 成功且 base 解析出聚合器模型，则重新解析并打路由标记（`model-resolver.ts:997-1016`）。

## 11. 常见边界

| 输入 | 结果 |
|---|---|
| `openrouter/z-ai/glm-4.7` | provider `openrouter`，id `z-ai/glm-4.7` |
| `openrouter/z-ai/glm-4.7@cerebras:high` | 模型 + 路由 `cerebras` + level `high` |
| `google-vertex/claude-opus-4-8@default` | 优先按字面 id 匹配；非聚合器不会把 `@default` 当路由 |
| `glm-5.3:max` | 若 catalog 真有 `glm-5.3:max`，字面 id 胜；否则模型 `glm-5.3` + `max` |
| `kimi-for-coding:high` | 先递归 `kimi-for-coding`，不会吸收到 `kimi-for-coding-highspeed` |
| `opus` | 裸模糊：精确 id → 别名/日期优先 → 最新版本 |
| `@unknown` | 不是角色，按字面模式走模糊匹配，通常无结果 |
| `openai/*` 出现在 `modelRoles.default` | 不展开为 glob；glob 只在 scope 设置里生效 |
