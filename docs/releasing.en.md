English | [简体中文](./releasing.md) | [Back to README](../README.en.md)

# Versions and releases

## Version numbers

Versions follow semver. `MAJOR.MINOR.FIX` is the release line and is set by hand; an optional `-alpha.N` / `-beta.N` prerelease is also set by hand only. Automation only appends build metadata (`+…`) when it publishes a build, and semver ignores that part for precedence.

The version is stored in four files, and `tests/unit/version.test.mjs` checks that they agree:

- `manifest.json`
- `package.json`
- `server-plugin/package.json`
- `src/constants.js`

Each file also carries an integer `versionCode`, incremented every time the version is written.

## Channels

| Channel | Example version | Where | Produced by |
|---|---|---|---|
| Main | `2.0.0` | `main` branch | Human commits. Automation never commits to `main` |
| Nightly | `2.0.0+nightly.20261103` | `nightly` branch, `nightly-YYYYMMDD` tag, workflow artifact | Daily build at 05:30 (UTC+8) |
| Release | `2.0.0` | Git tag `v2.0.0` and a GitHub Release | Pushing a tag by hand |

- The date `YYYYMMDD` is always computed in UTC+8.
- `versionCode` only increases within a channel: `main` adds one to its own version files, Nightly adds one to the highest value on the `nightly` branch. The two channels' numbers are never compared, so a Release with a lower `versionCode` than a newer Nightly is expected.
- The extension's update check only reads the selected channel's `manifest.json`. Within the build's own channel it compares `versionCode` first, then semver and the nightly date; across channels `versionCode` is not compared. GitHub Releases and commit history are never read.

## Workflows

| File | Trigger | Effect |
|---|---|---|
| `.github/workflows/checks.yml` | Push to `main`, pull requests, manual | Runs `npm test` and `npm run validate` on Node 18, 20 and 22; writes nothing |
| `.github/workflows/nightly.yml` | Daily at 21:30 UTC (05:30 UTC+8 the next day), manual | Finds the last `main` push with passing checks on the previous UTC+8 day and skips if there is none. Otherwise reruns the checks on that commit, writes the nightly version, force-pushes the `nightly` branch, tags `nightly-YYYYMMDD` and uploads a zip artifact. No Release is created |
| `.github/workflows/release.yml` | Pushing a `v*` tag | Reruns the checks, verifies the tag matches the version files, then creates a GitHub Release with a source zip. Nothing is published if any step fails |

A manual Nightly run accepts a `day` input (`YYYY-MM-DD`) to build a specific day.

## Version tool

```bash
npm run version:manual -- 2.0.0            # set the release line (optionally -beta.N); versionCode +1
npm run version:nightly -- --date 20261102 # used by the Nightly workflow
npm run version:check-tag -- v2.0.0        # check a tag against the version files
```

The implementation is `tools/version.mjs`. Running `version:manual` with an unchanged version only bumps `versionCode`.

## Publishing a Release

1. Make sure the code to release is on `main` and the latest **Checks** run passed.
2. Set the version:

   ```bash
   git pull --ff-only
   npm run version:manual -- 2.0.0
   ```

3. Commit and push:

   ```bash
   git add manifest.json package.json server-plugin/package.json src/constants.js
   git commit -m "chore(release): 2.0.0"
   git push origin main
   ```

4. Once **Checks** passes, tag it. The tag must equal the current version (such as `v2.0.0-beta.1`) or its base version without the prerelease (such as `v2.0.0`):

   ```bash
   git tag v2.0.0
   git push origin v2.0.0
   ```

5. When the **Release** workflow finishes, the GitHub Release contains `omtp-v2.0.0.zip`.

To publish the current `main` as a Release without changing the version, tag that commit `v<current version>`.
