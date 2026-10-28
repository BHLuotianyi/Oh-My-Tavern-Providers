# Settings、分层与持久化

模型选择相关的状态分四类存放，混在一起会导致"改了但下次启动没用"：

1. **Settings 层**：角色分配、白名单、provider 顺序、thinking 默认值、回退链等。
2. **模型定义文件**：`models.yml`（provider/model/override），不是 settings。
3. **会话日志**：当前会话的 `model_change` / `thinking_level_change` / `service_tier_change`。
4. **本地使用数据**：`agent.db` 的 MRU 与性能表，只影响排序/展示。

## 1. Settings 分层与优先级

`Settings` 实例持有四个层对象（`config/settings.ts:593-604`）：

```text
#global        全局配置（当前 profile）
#project       项目配置（<cwd>/.omp/config.yml）
#configOverlay --config 指定的覆盖文件
#overrides     运行时 override（CLI、SDK、扩展）
```

读取优先级（高 → 低）：

```text
env var → runtime override → --config overlay → project → global(profile) → schema default
```

合并规则（`settings.ts:3879-3926`）：

- 记录类型**深合并**；后层同键覆盖前层。
- 数组类型**整体替换**，不做元素合并。因此更高层的 `disabledProviders` 会丢掉低层的 scoped 条目。
- 键顺序：高层键排在前；这对 `retry.fallbackChains`、`modelPresets` 等依赖顺序的 map 有意义。
- 项目层的 `modelRoles.<role> = null` 是**清除墓碑**：回退到 global。runtime/overlay 的 `null` 则是阻塞下层。

数据来源：

| 层 | 位置 / 来源 |
|---|---|
| global | `<agentDir>/config.yml`，默认 `~/.omp/agent/config.yml`；profile 通过 `--profile` / `PI_CODING_AGENT_DIR` 改变 |
| project | `<cwd>/.omp/config.yml` |
| overlay | `--config <file>`、`PI_CONFIG_FILES` |
| runtime | `settings.override*`、CLI flag、SDK options、扩展 |
| env | 每个 setting 声明里的 `env` |

## 2. 模型相关 settings 清单

### 2.1 选择与角色

| Key | 类型 | 默认 | 作用 |
|---|---|---|---|
| `modelRoles` | `Record<role, selector>` | `{}` | 角色 → 模型选择器；模型选择的核心配置 |
| `modelRoleStorage` | `"global" \| "project"` | `"global"` | Hub/预设写角色时去哪个作用域 |
| `modelPresets` | `Record<name, ModelPreset>` | `{}` | 角色 + thinking 的命名快照 |
| `modelTags` | `Record<role, {name,color?,hidden?}>` | `{}` | 自定义角色/显示元数据；不改变解析 |
| `modelProviderOrder` | `string[]` | `[]` | provider 优先级 |
| `cycleOrder` | `string[]` | `["smol","default","slow"]` | 角色循环顺序 |
| `enabledModels` | `string[]`（支持路径 scoped） | `[]` | 白名单/启动作用域；空表示不限制 |
| `disabledProviders` | `string[]`（支持路径 scoped） | `[]` | 从可用集合中移除整个 provider |
| `enabledProviders` | `string[]` | `[]` | **与模型选择无关**：外部配置源发现开关 |

`enabledModels` / `enabledProviders` / `disabledProviders` 支持路径前缀条目：

```yaml
enabledModels:
  - claude-sonnet-4-5          # 全局生效
  - path: ~/work               # 仅该目录及其子目录
    models:
      - anthropic/claude-opus-4-5
```

键可以写 `path` / `paths` / `pathPrefix` / `pathPrefixes`；`enabledModels` 用 `models`，provider 设置用 `providers`，也可统一用 `values`。路径作用域在 setting 合并之后解析。

`enabledModels` 的语义是"作用域 + 白名单"：

- `--models` 未给出时，启动作用域取自它；
- `ModelControls.getAvailableModels()` 会用它过滤；
- `resolveAllowedModels` 在它非空时只返回匹配模型，**匹配不到就是空集**，不会回退到全局默认。

### 2.2 thinking 与推理

| Key | 类型 | 默认 | 作用 |
|---|---|---|---|
| `defaultThinkingLevel` | 级别 + `auto` | `high` | 新会话/未指定时的 thinking 默认 |
| `providers.autoThinkingMaxEffort` | `xhigh \| max` | `xhigh` | `auto` 分类器的上限 |
| `thinkingBudgets.{level}` | number | `1024…32768` | 各档 reasoning token 预算 |
| `hideThinkingBlock` / `expandThinkingBlocks` / `proseOnlyThinking` / `omitThinking` | boolean | 见源码 | 展示/请求整形，不改变选择 |
| `externalThinking` | boolean | `false` | 禁用原生 reasoning |

thinking 级别本身不是设置项，而是会话状态；`defaultThinkingLevel` 只提供初值。

### 2.3 service tier / provider 行为

| Key | 作用 |
|---|---|
| `tier.openai` / `tier.anthropic` / `tier.google` | provider 家族默认 tier（`none` 等） |
| `tier.subagent` | 子代理 tier，可 `inherit` |
| `tier.advisor` | advisor tier |
| `providers.anthropic.slowMode` | `/slow` 的 Anthropic 分支会写这里 |
| `providers.fireworksTier` | Fireworks 专用 tier |
| `providers.openaiWebsockets` 等 | 传输选择，不改变模型身份 |

`/fast` 与 `/slow` 的 flex/priority 选择是**会话级**，通过 `service_tier_change` 日志保存；只有 Anthropic slow 会落到 settings。

### 2.4 回退与重试

| Key | 默认 | 作用 |
|---|---|---|
| `retry.enabled` | `true` | 总开关 |
| `retry.modelFallback` | `true` | 是否允许模型回退 |
| `retry.fallbackOn` | `any` | 哪些错误触发回退 |
| `retry.fallbackChains` | `{}` | 角色/模型/通配 key → 选择器数组 |
| `retry.fallbackRevertPolicy` | `cooldown-expiry` | 何时回到主模型 |
| `retry.usageAwareFallback` / `usageReserve*` | `false` | 额度感知的账号选择 |

### 2.5 上下文与压缩

| Key | 默认 | 作用 |
|---|---|---|
| `extendedContext` | `false` | 使用模型的 `maxContextWindow` |
| `contextPromotion.enabled` | `false` | 上下文溢出时提升到 `contextPromotionTarget` |
| `compaction.enabled` | `true` | 自动压缩 |
| `compaction.thresholdPercent` / `thresholdTokens` / `reserveTokens` / `keepRecentTokens` | 见源码 | 压缩阈值 |
| `compaction.modelThresholds` | `{}` | 按模型覆盖阈值，也可触发扩展窗口 |

`compactionModel` 不是 setting，而是模型定义里的字段（`models.yml` 的 model / `modelOverrides`）。

## 3. 写路由：global vs project

所有 setting 的 `set()` 默认写 **global** 层；模型角色是唯一有专门项目写路径的配置。

| API | 写入 | 说明 |
|---|---|---|
| `settings.setModelRole(role, value)` | global `modelRoles.<role>` | 按单个角色增量保存；同时同步 runtime override 槽位 |
| `settings.setProjectModelRole(role, value)` | project `modelRoles.<role>` | 写 `<cwd>/.omp/config.yml` |
| `settings.clearProjectModelRole(role)` | project `null` | 清除项目值，回退 global |
| `settings.overrideModelRoles(map)` | runtime | 整份覆盖语义；不落盘 |
| `setting.set(value)` | global | 通用设置写路径 |
| `setting.override(value)` | runtime | 临时覆盖 |

读取侧要区分：

| 方法 | 含义 |
|---|---|
| `getModelRole(role)` | 合并后的有效值 |
| `getGlobalModelRole(role)` | 仅 global 层 |
| `getProjectModelRole(role)` | 仅 project 层 |
| `getModelRoleSource(role)` | `project \| global \| default`（只看持久层） |
| `getModelRoleProvenance(role)` | `runtime \| overlay \| project \| global \| default`（含墓碑语义） |

为什么需要 `provenance`：Model Hub 在 `modelRoleStorage = project` 时，如果直接把值写进 project 层，但 runtime 层已有更高优先级的值，用户会看到"写了没生效"。OMP 的做法是：

- 捕获并临时替换 runtime override 槽位；
- 写入目标层后，让 runtime 槽位继续反映项目值；
- 清理角色时同时处理项目层与 runtime 槽位；
- 通过 `getModelRoleProvenance` 判断是否需要写另一层。

移植时如果不需要"同一进程内 global/project 双写 + runtime 覆盖"，可以简化；但至少要保留 **有效值、持久层来源、运行时覆盖** 三个概念。

## 4. 预设的存储语义

`ModelPreset`：

```ts
{
  modelRoles: Record<string, string>,   // role → selector（可带 :level）
  defaultThinkingLevel?: ConfiguredThinkingLevel
}
```

- 每条预设整体存储；同名预设**不会**跨层合并，最高层整体胜出。
- runtime/overlay 的 `null` 条目会隐藏低层预设；project/global 的 `null` 视为未设置。
- `getOwnedModelPreset(name)` 返回 `{ entry, source }`，便于提示"保存成功但被更高层遮蔽"。
- 预设切换写角色的方式与 Hub 一致：看 `modelRoleStorage`；未包含的角色会被清除。

## 5. 会话日志与恢复

会话 Journal（`session-entries.ts`）：

```ts
type ModelChangeEntry = {
  type: "model_change";
  model: string;                      // provider/id
  role?: string;                      // default / smol / temporary / ephemeral 角色
  resolvedModelIsFallback?: boolean;
};

type ThinkingLevelChangeEntry = {
  type: "thinking_level_change";
  thinkingLevel: ThinkingLevel;       // 当前具体值
  configured?: ConfiguredThinkingLevel; // 可能是 auto
};
```

写入点：

- `ModelControls.setModel` → `appendModelChange(selector, role)`
- `setModelTemporary` → 角色 `"temporary"` 或 ephemeral 角色
- 每次显式/临时切换、回退切换、角色循环都会写
- thinking 变化写 `appendThinkingLevelChange`

恢复：

- `buildSessionContext` 把 `model_change` 折叠成 `models[role]`，最后一条 `thinking_level_change` 作为当前 thinking。
- `getRestorableSessionModels` 取"最后一条非 ephemeral model_change 的角色"，没有则 `default`。
- 启动时只在没有显式模型时恢复；逐候选检查 `hasConfiguredAuth`。
- `switchSession` 恢复时优先使用 `configured` thinking 值，保证 `auto` 会话仍在 auto。
- 失败回滚：`agent.setModel` 直接恢复旧模型，并发出修正性 `model_changed`。

**没有"最后使用模型"的 settings key。** 上次模型只存在于会话日志；跨会话的"最近使用"是 MRU 排序，不是默认值。

## 6. MRU 与性能数据

`agent.db` 中：

| 表 | 列 | 用途 |
|---|---|---|
| `model_usage` | `model_key` PK, `last_used_at` | 解析 tie-break、Picker 的 Recent、provider 亲和 |
| `model_perf` | `model_key`, TPS/TTFT 等 | 仅 UI 展示 |

- 写入点：每次模型切换（显式、临时、循环、回退、advisor）。
- 读取：`getModelMatchPreferences` → `usageOrder`；`model-browser-source` → `mruOrder` / `modelPerf`。
- 这些数据**不写 config.yml**，也不属于用户可编辑配置。

## 7. 表面 × 状态 写入矩阵

| 操作 | `modelRoles` | `defaultThinkingLevel` | 会话日志 | MRU | service tier |
|---|---|---|---|---|---|
| TUI `/model` → Hub 分配角色 | 是（按 storage scope） | 仅 `auto` 时 | 是（default 角色切换时） | 是 | 否 |
| TUI `/model` 聚焦子代理 | 否 | 否 | 是（目标会话） | 是 | 否 |
| TUI `/switch` / alt+p | 否 | 否 | 是 | 是 | 否 |
| ACP `/model <sel>` | 否 | 否 | 是 | 是 | 否 |
| ACP `/switch <sel>` | 否 | 否 | 是 | 是 | 否 |
| ACP `set_config_option(model)` | 否 | 否 | 是 | 是 | 否 |
| RPC `set_model` | 否 | 否 | 是 | 是 | 否 |
| `ctrl+p` 角色循环 | 否 | 否 | 是 | 是 | 否 |
| `/modelpreset save` | 否 | 否（写入预设） | 否 | 否 | 否 |
| `/modelpreset switch` | 是 | 仅预设包含时 | 是 | 是 | 否 |
| `/effort` | 否 | 否 | 是 | 否 | 否 |
| `/fast` | 否 | 否 | 是 | 否 | 是（会话） |
| `/slow`（Anthropic） | 否 | 否 | 是 | 否 | 是（全局 setting） |
| `--model` | runtime 覆盖 default | 否 | 是 | 是 | 否 |
| `--smol/--slow/--plan` | runtime 覆盖 | 否 | 视使用 | 否 | 否 |
| 启动恢复 | 否 | 否 | 否（读取） | 否 | 否 |

## 8. 移植建议的配置形态

如果目标系统没有 profile/project 双层，可以保留同样的**语义分层**，但压缩成两层：

```ts
interface ModelSelectionConfig {
  roles: Record<string, string>;        // 有效角色配置
  enabledModels?: string[];             // 白名单/作用域
  disabledProviders?: string[];
  providerOrder?: string[];
  cycleOrder?: string[];
  defaultThinkingLevel: string;
  presets?: Record<string, ModelPreset>;
  fallbackChains?: Record<string, string[]>;
  roleStorage?: "global" | "project";    // 若支持双作用域
}
```

必须保留的行为：

- 空数组 ≠ 未设置（`enabledModels: []` 表示不限制；`fallbackChains.role: []` 表示禁用）。
- 角色没有配置时返回"无"，不要伪造默认值。
- 写角色必须支持"只持久化一个 role"，而不是整份 map 重写，避免覆盖其他进程/用户的并发修改。
- 引入 runtime override 层，否则 CLI/SDK 的临时选择会污染持久配置。
