# Desktop updates

Settings → About → Updates shows the installed version, a manual check, and **Receive pre-release updates** (off by default, stored per device).

The desktop checks 10 seconds after launch, every six hours while visible, when returning after that interval, and when the network comes back. A small dismissible card announces a newer version. **View update** shows release notes; **Download update** downloads and verifies the signed package. **Install and restart** saves pending page/board edits and waits for database commands before installing. A save failure blocks installation. An open drawing dialog must be finished first. “Later” suppresses repeated notices for that version until the next launch; the update stays accessible in Settings.

Stable checks use GitHub's `/releases/latest`, which follows the release marked **Latest**. When previews are enabled, published pre-releases with a `latest.json` asset are considered as well. The highest newer semantic version wins, including numeric pre-release identifiers (`beta.10` follows `beta.2`). Drafts, old versions, and downgrades are excluded. Turning previews off while a check is running discards its result and checks the stable channel again. A newer installed preview is not downgraded to an older stable version.

## One-time signing setup

Generate an updater key **outside this repository** with the Tauri CLI:

```sh
cd spike/tiptap
npm run tauri signer generate -- -w /secure/location/nevis-updater.key
```

Keep a secure backup of the private key and its password. All subsequent releases must use the same key pair so existing installations can verify them. These updater keys are separate from macOS/Windows code-signing certificates.

In the repository's Actions settings, add:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `NEVIS_UPDATER_PUBLIC_KEY` | Contents of `nevis-updater.key.pub` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of `nevis-updater.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key password, if set |

The build creates an ignored `tauri.updater.conf.json` containing only the public key and updater-artifact flag. The signing key is never written into the app or repository. Release builds fail early when the required signing configuration is missing. Ordinary local builds still work without signing; their Updates panel explains that updates are unconfigured.

## Publishing

Stable tags (`v1.2.0`) must point to commits on `main`. Preview tags (`v1.3.0-beta.1`) must point to commits on `dev`. Keep the package, package lock, Tauri, Cargo and Cargo lock versions in sync and add `docs/releases/<tag>.md`, as for existing releases.

The installer workflow builds Windows and universal macOS packages, signs updater artifacts and assembles `latest.json`. Platform builds run sequentially to avoid concurrent writes to that manifest. Before publication, the workflow verifies that the manifest has signed entries and matching release assets for Windows x64 and both Mac architectures. Pre-releases are published with `--latest=false`; stable releases become Latest only after both builds finish.

Existing installations without this feature need one final manual installation. Later updates can then use the built-in updater. End-to-end installation must be smoke-tested on Windows and macOS using two signed releases before the first public rollout.

## Verification

```sh
node --test db/test-updates.mjs
node --test db/tests/database/persistence.test.mjs
cd spike/tiptap && npm run build
cd src-tauri && cargo test updates::tests
```

The controller tests cover channel changes during requests, explicit approval, session dismissal, concurrent requests, failed downloads and save-before-install failures. Rust tests cover semantic version ordering, Latest/preview selection, drafts and missing manifests.

Reference: [Tauri updater documentation](https://v2.tauri.app/plugin/updater/).

## macOS replacement installer

Releases include `Nevis-macOS.pkg` alongside the DMG and signed updater archive. Use the PKG for the first manual upgrade: it installs at `/Applications/Nevis.app` and removes `/Applications/Noviq.app` only after confirming both application identifiers match the existing product. The installer refuses symbolic links and unrelated applications at these paths, and asks for running copies to be closed. The component is not relocatable, so a copy mounted from a DMG cannot redirect the installation. Account files, Keychain entries and workspace folders are not packaged or removed. Later signed updates use the existing in-app updater.

The package build and scripts are checked using temporary directories by `.github/scripts/test-macos-installer.py`. A real system installation and signed update between releases still require release smoke testing. The PKG is currently unsigned, matching the existing distribution's lack of an Installer signing identity.
