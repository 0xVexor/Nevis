# Development and releases

Nevis uses two permanent branches:

- `dev` is the default branch for development. Create feature and fix branches from it, and open pull requests back into `dev`.
- `main` contains final releases only. Its pull requests must come from `dev` in this repository. Direct pushes, force pushes and branch deletion are disabled.

## Everyday work

```sh
git switch dev
git pull --ff-only
git switch -c feature/short-description
# Make changes, commit, push, then open a pull request into dev.
```

Fixes follow the same route through `dev`. Keep unfinished work out of the release pull request.

## Final releases

1. On `dev`, update the app version in `spike/tiptap/package.json`, its package lock, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` and `src-tauri/tauri.conf.json`.
2. Add the release notes in `docs/releases/vX.Y.Z.md` and finish the release changes on `dev`.
3. Open a pull request from `dev` into `main`. The release policy verifies the source branch, matching versions, and an increase over the current stable version. Required checks must pass before merging.
4. Merge the release pull request, then tag that exact `main` commit:

   ```sh
   git fetch origin
   git switch main
   git pull --ff-only origin main
   git tag -a vX.Y.Z -m "Nevis X.Y.Z"
   git push origin vX.Y.Z
   ```

5. The installer workflow checks that the tag is on `main` and matches all version files. It builds Windows EXE/MSI and universal macOS DMG packages, then publishes the final release only after both platforms succeed. A failed platform leaves the release as a draft.
6. Merge `main` back into `dev` so development includes the release merge. Do not squash release merges or the merge back into `dev`; preserving ancestry keeps future release comparisons clear.

Manual installer builds are available only from `main` and do not publish a release. Final tags use `vX.Y.Z`; publishing a final tag does not replace the required `dev` to `main` pull request.

## Pre-releases and desktop updates

Pre-release tags such as `v1.3.0-beta.1` must point to commits on `dev`. Update the same version files and add the tag's release notes before tagging. The installer workflow publishes these as pre-releases without changing the stable Latest release. Users receive them only when they enable pre-release updates in Settings → About → Updates.

Both release channels require the updater signing configuration described in [desktop updates](updates.md). Platform builds finish and the signed update manifest is checked before publication. Feature pull requests still target `dev`; final releases still flow from `dev` to `main`.

## Compatibility

Product renaming retains the application identifier, vault marker format and local database names and must not relocate user data. The sync reliability follow-up separately introduces protocol 2 and profile-scoped session credentials for safety; shared legacy credentials require a fresh sign-in. See [sync reliability](sync-reliability.md) for the deliberate compatibility boundary and coordinated rollout requirements. The legacy `NOVIQ_SERVER` build variable is still accepted; new builds may use `NEVIS_SERVER` instead.
