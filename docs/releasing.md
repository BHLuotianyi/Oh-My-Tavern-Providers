[English](./releasing.en.md) | 简体中文 | [返回 README](../README.md)

# 版本与发布

## 版本号

版本号遵循 semver。`MAJOR.MINOR.FIX` 是发布线，由人工设置；可选的预发布标签 `-alpha.N` / `-beta.N` 也只由人工设置。自动化只在发布构建时追加 build metadata（`+…`），semver 比较先后时忽略这一部分。

同一个版本号写在四个文件里，`tests/unit/version.test.mjs` 检查它们一致：

- `manifest.json`
- `package.json`
- `server-plugin/package.json`
- `src/constants.js`

此外每个文件都有一个整数 `versionCode`，每次写入版本号时加 1。

## 通道

| 通道 | 版本号示例 | 位置 | 产生方式 |
|---|---|---|---|
| Main | `2.0.0` | `main` 分支 | 人工提交。自动化从不向 `main` 提交 |
| Nightly | `2.0.0+nightly.20261103` | `nightly` 分支、`nightly-YYYYMMDD` 标签、工作流制品 | 每天 05:30（UTC+8）自动构建 |
| Release | `2.0.0` | Git 标签 `v2.0.0` 与 GitHub Release | 人工推送标签 |

- 日期 `YYYYMMDD` 固定按 UTC+8 计算。
- `versionCode` 只在同一通道内递增：`main` 在自己的版本文件上加 1，Nightly 在 `nightly` 分支已有的最大值上加 1。两个通道的数字互不比较，因此 Release 的 `versionCode` 小于更新的 Nightly 是正常的。
- 扩展的更新检查只读取所选通道的 `manifest.json`：同通道时先比较 `versionCode`，再比较 semver 与 nightly 日期；跨通道时不比较 `versionCode`。不读取 GitHub Release，也不读取提交历史。

## 工作流

| 文件 | 触发 | 作用 |
|---|---|---|
| `.github/workflows/checks.yml` | 推送到 `main`、Pull Request、手动 | 在 Node 18、20、22 上运行 `npm test` 与 `npm run validate`，不写任何文件 |
| `.github/workflows/nightly.yml` | 每天 21:30 UTC（UTC+8 次日 05:30）、手动 | 找出前一个 UTC+8 自然日里最后一次检查通过的 `main` 推送；没有则跳过。否则在该提交上重跑检查，写入 nightly 版本号，强制推送到 `nightly` 分支，打 `nightly-YYYYMMDD` 标签并上传 zip 制品。不创建 Release |
| `.github/workflows/release.yml` | 推送 `v*` 标签 | 重跑检查，确认标签与版本文件一致，然后创建 GitHub Release 并附上源码 zip。任一步失败都不会发布 |

手动运行 Nightly 时可以用 `day` 输入（`YYYY-MM-DD`）指定构建哪一天。

## 版本工具

```bash
npm run version:manual -- 2.0.0            # 设置发布线（可带 -beta.N），versionCode 加 1
npm run version:nightly -- --date 20261102 # Nightly 工作流使用
npm run version:check-tag -- v2.0.0        # 检查标签与版本文件是否一致
```

实现见 `tools/version.mjs`。版本号不变时运行 `version:manual` 只更新 `versionCode`。

## 发布一个 Release

1. 确认要发布的代码已在 `main`，且最近一次 **Checks** 通过。
2. 设置版本：

   ```bash
   git pull --ff-only
   npm run version:manual -- 2.0.0
   ```

3. 提交并推送：

   ```bash
   git add manifest.json package.json server-plugin/package.json src/constants.js
   git commit -m "chore(release): 2.0.0"
   git push origin main
   ```

4. **Checks** 通过后打标签。标签必须等于当前版本（如 `v2.0.0-beta.1`），或去掉预发布标签后的基础版本（如 `v2.0.0`）：

   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```

5. **Release** 工作流完成后，GitHub Release 中会有 `omtp-v2.0.0.zip`。

不改版本号、只想把当前 `main` 发布为 Release 时，直接对该提交打 `v<当前版本>` 标签即可。
