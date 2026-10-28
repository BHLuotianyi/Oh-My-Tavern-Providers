## 描述 / Description
<!--- 简要说明本次变更的目的、背景以及解决的问题 / Briefly describe the purpose, background, and problem solved by this PR -->

## 变更类型 / Type of Change

- [ ] 🐛 Bug 修复 / Bug Fix
- [ ] ✨ 新功能或服务商适配 / New Feature or Provider Adapter
- [ ] 📦 目录或人格快照更新 / Catalog or Personality Snapshot Update
- [ ] ♻️ 代码重构或简化（行为不变） / Refactoring or Simplification (behavior-preserving)
- [ ] 📝 文档或翻译更新 / Documentation or i18n Update
- [ ] 🔧 其他（请说明） / Other (please describe):

## 关联 Issue / Related Issues
<!--- 例如：Fixes #12 或 Relates to #34 / e.g., Fixes #12 or Relates to #34 -->

## 影响模块 / Affected Layers

- [ ] 客户端扩展核心 (`src/*.js`, `src/adapters/native.js`)
- [ ] 客户端 UI 与样式 (`src/ui/*.js`, `style.css`, `settings.html`, `i18n/*.json`)
- [ ] 服务端网关与密钥库 (`server-plugin/index.mjs`, `server-plugin/lib/*.mjs`)
- [ ] 协议转换或额度适配器 (`server-plugin/lib/adapters/*`, `usage.mjs`, `custom-logins/*`)
- [ ] 模型目录或构建脚本 (`catalog/*`, `server-plugin/catalog/*`, `tools/*.mjs`)
- [ ] 测试与文档 (`tests/**`, `README*.md`, `docs/**`)

## 检查清单 / Checklist

- [ ] 我已阅读并遵循 [CONTRIBUTING.md](../CONTRIBUTING.md) 中的架构边界与质量护栏 / I have read and followed [CONTRIBUTING.en.md](../CONTRIBUTING.en.md)
- [ ] 我已运行 `npm test` 且全部单元测试通过 / `npm test` passes locally
- [ ] 我已运行 `npm run validate` 确认双副本目录校验通过 / `npm run validate` passes locally
- [ ] 若修改了 `i18n/`，我确认 `en.json` 与 `zh-cn.json` 的键集合完全一致 / `i18n/en.json` and `i18n/zh-cn.json` remain in 1:1 sync
- [ ] 我确认 `server-plugin/` 未直接导入 `src/` 或仓库根目录下的文件 / `server-plugin/` remains standalone
- [ ] 我确认未提交任何真实 API Key、OAuth 密钥、Token 或本机绝对路径 / No secrets, tokens, or personal paths were committed
- [ ] 涉及 UI 变更时，我已附上截图或动图（如适用） / Added screenshots or recordings for UI changes (if applicable)

## 验证步骤与补充说明 / Verification & Additional Context
<!--- 请说明你是如何测试该变更的（例如：使用的服务商/模型、是否使用 npm run mock 联调、浏览器控制台输出等） -->
