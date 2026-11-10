# 运行时切换生命周期

本文回答：一次"换模型"到底改了什么，什么时候生效，哪些东西必须跟着重算。

## 1. 唯一变更入口

所有模型变更都汇聚到 `session/model-controls.ts` 的两个方法：

```text
setModel(model, role = "default", { selector?, thinkingLevel?, persist? })
setModelTemporary(model, thinkingLevel?, { ephemeral? })
```

再往下进入 `AgentSession.#setModelWithProviderSessionReset`，最后是 `Agent.setModel`。没有第二条直接改 `agent.state.model` 的业务路径；计划模式、回退链、扩展、ACP/RPC 都复用这两个方法。

## 2. 两条变更路径

### 2.1 持久化角色 `setModel`

```text
1. 记录切换前的 edit mode（供 system prompt 判断是否需要重建）
2. hasConfiguredAuth(model) 检查；没有凭据 → 抛 No API key for provider/id
3. modelRegistry.refreshSelectedModelMetadata(model)   # 惰性运行时元数据
4. modelRegistry.clearSuppressedSelector(路由选择器)
5. host.clearActiveRetryFallback()                     # 显式切换放弃回退所有权
6. host.setModelWithProviderSessionReset(model)
7. sessionManager.appendModelChange("provider/id", role)
8. 若 options.persist：
     settings.setModelRole(role, formatRoleModelValue(...))
9. settings.getStorage().recordModelUsage("provider/id")
10. 重新绑定 thinking：
      auto 保持 auto；
      否则优先模型 thinking.defaultLevel，其次保留当前值
11. host.syncAfterModelChange(previousEditMode)         # 重建模型相关 system prompt
```

`persist` 默认 `false`。只有 Model Hub 的全局角色分配、`--model` 之外的显式持久化路径才传 `true`。

### 2.2 会话临时模型 `setModelTemporary`

与上面相同，区别只有：

- 不写 `modelRoles`；
- 日志角色是 `"temporary"`，内部临时切换（prewalk、回退、计划模式）用 `EPHEMERAL_MODEL_CHANGE_ROLE`；
- 显式传入的 `thinkingLevel` 优先于模型默认值。

### 2.3 下层 `AgentSession.#setModelWithProviderSessionReset`

```text
if currentModel:
    closeProviderSessionsForModelSwitch(current, next)   # Codex/Responses 等 provider 侧会话
    if 真的换了模型:
        clearInheritedProviderPromptCacheKey()
agent.setModel(model)
if 真的换了模型:
    emit("model_changed")                                 # 同步事件
reconcileModelDependentState(model):
    - append-only context mode 重新评估
    - snapcompact archive 重新渲染
    - think tool 重新对账
```

`Agent.setModel` 本身只做两件事：

1. 应用会话的 model resolver：`agent.setModelResolver(next => modelRegistry.fitContextWindow(next, settings))`。因此每次设模型都会按当前 `extendedContext` / 阈值重新计算窗口。
2. 在 `countsAlike` 不成立时替换 tokenizer。

## 3. 模型依赖状态

切换后必须重新计算的东西：

| 状态 | 触发点 | 说明 |
|---|---|---|
| 请求实际使用的模型 | `AgentLoopConfig.getModel` | 每轮请求时读取 `agent.state.model` |
| 上下文窗口 | `fitContextWindow` | 扩展上下文/压缩阈值会改变有效窗口 |
| tokenizer | `Agent.setModel` | 影响计数与压缩边界 |
| system prompt | `syncAfterModelChange` | 模型 id（或 delegation bias / inline descriptor 决策）或 edit mode 变化时重建 |
| provider 侧会话 | `#closeProviderSessionsForModelSwitch` | 避免跨模型复用 Responses/Codex 历史 |
| 回退所有权 | `clearActiveRetryFallback` | 用户显式切换后，旧回退链不再自动恢复 |
| thinking | `#reapplyThinkingLevel` / `setThinkingLevel` | 独立轴，见 §4 |
| service tier | `effectiveServiceTier(model)` | 每轮请求时解析；会话内状态 |
| UI/状态栏 | `model_changed` 订阅 | TUI、ACP config option、RPC 都靠这个事件 |
| MRU | `recordModelUsage` | 影响下一次模糊解析与 Picker 排序 |

上下文窗口是**实时读取**的，不缓存副本：状态栏、压缩边界、`getContextUsage` 都直接读当前 `model.contextWindow`。

## 4. thinking 生命周期

### 4.1 词汇

```text
ConfiguredThinkingLevel =
  off | minimal | low | medium | high | xhigh | max   # ThinkingLevel
  | auto                                               # 编码代理层哨兵
  | inherit                                            # 沿用模型/会话默认
```

`auto` 永远不会作为 provider effort 发送；每轮分类后解析成具体 effort。`inherit` 在应用时转为 `undefined`。

### 4.2 初始化与默认

- 全局默认 `defaultThinkingLevel` 默认 `high`。
- 启动优先级（`sdk.ts:2120-2155`），逐项在上一项未定义时才继续：
  1. 显式 `--thinking`；
  2. 会话日志的 `configured` / concrete 值；
  3. 恢复模型选择器的 `:level`（仅当会话没有 thinking 日志）；
  4. `default` 角色的显式 `:level`（仅当没有显式模型、也没有 thinking 日志）；
  5. 选中模型的 `thinking.defaultLevel`（仅当全局默认不是 `auto`）；
  6. 全局 `defaultThinkingLevel`，经 `automaticThinkingLevel` 处理（`auto` 保持 auto；模型 `thinking.unverified` 时为 `undefined`）。

### 4.3 设置

`setThinkingLevel(level, persist = false)`：

- `auto` 分支：
  - 立即设置一个"临时具体档位"（`resolveProvisionalAutoLevel` 后钳制）；
  - 清除继承的 prompt cache key；
  - 写日志 `configured: "auto"`；
  - `persist` 时写 `defaultThinkingLevel = "auto"`；
  - 即使具体 effort 没变，`auto` 模式变化也算变化。
- 具体分支：
  - 钳制到模型支持范围与会话上限；
  - 离开 `auto` 一定写日志（即使解析出的 effort 相同），否则恢复会话会错误地回到 auto；
  - `persist` 只在 `effectiveLevel !== undefined && !== off` 时写设置。
- 每次实际变化都会清 prompt cache key、写 `thinking_level_change`、发 `thinking_level_changed`。

### 4.4 模型切换后的重绑

```ts
#reapplyThinkingLevel(preferredDefault?) {
  setThinkingLevel(
    autoThinking
      ? AUTO_THINKING
      : automaticThinkingLevel(model, preferredDefault ?? currentLevel)
  )
}
```

- `auto` 保持 auto，并按新模型重新钳制临时档位。
- 否则优先模型的 `defaultLevel`，再保留当前档位。
- `thinking.unverified` 的模型不会自动获得思考档位。

### 4.5 每轮 auto 分类

`applyAutoThinkingLevel`（`model-controls.ts:632-704`）：

1. 非 reasoning、`unverified`、无可控 effort 的模型直接跳过。
2. `ultrathink` 魔法词绕过分类器和 ceiling，直达模型最高档。
3. 否则用 `judge` 角色链做难度分类，4 秒超时。
4. 分类期间 prompt 被替换/取消 → 丢弃结果。
5. 结果钳制到 `providers.autoThinkingMaxEffort` 与会话上限；默认不低于 `low`。
6. 只有 effort 实际变化才写日志；事件带 `configured: "auto"` 与 `resolved`。

## 5. 上下文窗口、压缩与切换

### 5.1 超上下文切换

两条路径不同：

- **TUI `/switch` 与 alt+p Picker**：先比较当前 transcript tokens 与目标 `contextWindow`；超限则先压缩，压缩成功后切换，失败/取消保持原模型。
- **`session.setModel`（Hub、ACP、RPC、扩展）**：不主动压缩。`AgentSession.setModel` 的注释明确：下一次 prompt 的压缩/错误恢复负责处理，不把会话钉在旧模型上。

移植时至少要选一种明确策略，并让 UI 与 API 行为一致。

### 5.2 扩展上下文

`extendedContext` 切换会：

- 重新计算模型窗口（`reapplyModelPolicies`）；
- 若当前模型窗口变化，重新绑定（同模型不重置 provider session）；
- 影响压缩阈值与 `getContextUsage`。

### 5.3 上下文提升与压缩模型

- `contextPromotion`：溢出时临时切到 `contextPromotionTarget`（`setModelTemporary(..., { ephemeral: true })`），完成后可回到主模型。
- 压缩：按 `compactionModel` → 当前模型 → chat 角色 → 最大窗口模型 的顺序尝试；压缩模型**不会**改变会话主模型。

## 6. 回退链运行时

`retry.fallbackChains` 是"请求失败时的模型跳转"，不是用户选择：

- 触发：错误分类命中 `fallbackOn`，且 `retry.modelFallback` 打开。
- 跳转步骤（`turn-recovery.ts:2132-2210`）：
  1. 解析候选并校验凭据；
  2. 钳制 thinking；
  3. 在切换**之前**标记 fallback 路由；
  4. `setModelWithProviderSessionReset`；
  5. 追加 `model_change`，角色为 ephemeral，`resolvedModelIsFallback = true`；
  6. 记录 MRU；
  7. 应用下一档 thinking；
  8. 重建 system prompt；
  9. 发 `retry_fallback_applied`。
- 恢复主模型：`cooldown-expiry` 策略下，在下一轮前尝试回主模型；被 pin 或 suppressed 时跳过。
- **任何显式模型切换都会清除回退所有权**，避免用户手动切走后又被自动切回。

## 7. 角色在运行时被谁消费

| 角色 | 消费方 | 解析点 |
|---|---|---|
| `default` | 主会话 | 启动/会话恢复/自动挑选 |
| `smol` | 快速任务、标题、prewalk 目标；`tiny`/`memory`/`widget` 的默认链来源 | `resolveRoleModelFull`、`resolveAgentModelSelection` |
| `slow` | 深度思考、advisor 的配置回退 | 同上 |
| `plan` | 计划模式进入/退出 | `resolvePlanModelTransition` |
| `task` | 子代理 | `resolveAgentModelSelection`；请求 > 设置覆盖 > agent frontmatter > 会话继承 |
| `compactionModel`（模型字段） | 压缩 | `resolveCompactionModelCandidates` |
| `contextPromotionTarget`（模型字段） | 上下文提升 | `resolveContextPromotionTarget` |
| `judge` | 判定、auto-thinking 分类器 | `judgeRoleChain` + 会话模型兜底 |
| `tiny` / `memory` | 在线小任务、记忆 | `smol` 派生链 |
| `advisor` | 第二意见审查 | `resolveAdvisorRoleSelection` |
| `commit` | 提交信息生成 | `commit` → `smol` → chat 角色 |
| `image` / `web` / `speech` / `dictation` | kind 专用工具 | 角色池按 `accepts` 过滤 |
| `@model` mention | 子代理 | `ModelMentionRegistry` 把 mention 暴露为 task agent |

子代理的一个关键语义：**未配置 `task` 时继承当前会话模型**，而不是回退到某个全局默认。实现通过 `getActiveModelString()` 注入。

## 8. 并发与生命周期约束

- **流式响应中**：不能直接切换计划模式模型；OMP 把切换排队到 run settle 后（`#pendingModelSwitch` / `flushPendingModelSwitch`）。
- **同模型不同 thinking**：不要调用 `setModelTemporary`；直接 `setThinkingLevel`，避免不必要的 provider session 重置。
- **switchSession 失败**：直接 `agent.setModel(previous)` 回滚，并发出修正性 `model_changed`，不重复写日志。
- **焦点子代理**：`/switch` 作用于 `viewSession`；Hub 会强制退化为 Picker，避免给子代理分配主会话角色。
- **回退与用户切换竞争**：显式切换先 `clearActiveRetryFallback`；回退切换本身有 abort/竞态检查，模型不匹配则回滚。
- **provider 侧会话**：跨 provider/id/api 切换必须关闭；同模型仅改窗口/thinking 不需要。

## 9. 移植清单

如果要在非 CLI 系统中复刻，至少保留：

1. 一个 `ModelControls` 等价物，集中处理"设模型 + 日志 + 持久化 + thinking + 事件"。
2. `setModel` / `setSessionModel` 两个明确 API，不提供一个带 `persist` 布尔的多义方法（容易误用）。
3. 模型变更后的依赖重算钩子：窗口、tokenizer、system prompt、tool set、provider session、缓存键。
4. thinking 作为独立状态，带 `configured` 与 `resolved` 两个值，才能正确恢复 `auto`。
5. 超上下文切换的明确策略（先压缩 vs 交给下一轮）。
6. 回退链与用户选择的优先级：用户显式操作永远清除自动回退。
