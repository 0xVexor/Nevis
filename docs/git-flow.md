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

Manual installer builds are available only from `main` and do not publish a release. Tags beginning with `v` are reserved for final releases. Publishing a tag does not replace the required `dev` to `main` pull request.

## Compatibility

Nevis retains the existing application identifier, vault marker format, local database names, credentials service and sync protocol. Renaming the product must not relocate user data, forget accounts or disconnect existing devices. The legacy `NOVIQ_SERVER` build variable is still accepted; new builds may use `NEVIS_SERVER` instead.
