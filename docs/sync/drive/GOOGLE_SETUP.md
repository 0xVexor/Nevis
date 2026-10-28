# Google configuration and live verification

Do not use a real Vault for initial validation. The implementation is experimental and has internal release gaps in addition to the missing OAuth/account tests.

1. In Google Cloud Console create/select one publisher project for both desktop platforms and enable Drive API.
2. Configure consent branding, audience and test users. Create an OAuth client of type **Desktop app**. Use the same client/app identity on both test devices.
3. Requested scopes are `drive.file`, `openid`, and `email`. The latter two bind the root to a stable Google subject. Do not broaden to full Drive access to work around failed discovery.
4. Supply the public desktop client ID at build time. No access/refresh token or confidential client secret belongs in Git, public configuration, backups or logs.

From `spike/tiptap`:

```sh
NEVIS_DRIVE_SYNC_ENABLED=1 \
NEVIS_GOOGLE_CLIENT_ID='<your desktop client ID>' \
NEVIS_GOOGLE_CREDENTIAL_SERVICE=nevis.drive.preview.v1 \
npm run tauri -- build --debug --config src-tauri/tauri.drive-preview.conf.json --bundles app
```

Windows PowerShell:

```powershell
$env:NEVIS_DRIVE_SYNC_ENABLED='1'
$env:NEVIS_GOOGLE_CLIENT_ID='<your desktop client ID>'
$env:NEVIS_GOOGLE_CREDENTIAL_SERVICE='nevis.drive.preview.v1'
npm run tauri -- build --debug --config src-tauri/tauri.drive-preview.conf.json
```

The example JSON is a configuration reference, not automatically loaded. Actual build variables are allowlisted in build.rs. The preview identifier is `com.vexor.nevis.drive-preview`; it uses separate app-data. Production Drive is disabled unless explicitly built with the flag. Do not enable a release merely because a preview connects.

Authentication opens the system browser and receives a state-validated callback on an ephemeral `127.0.0.1` listener. PKCE verifier stays in memory. Cancel/timeout/restart do not persist an authorization code. Tokens and subject/email are stored together in the OS credential store; there is no plaintext fallback. Keychain/Credential Manager failures stop sign-in. Refresh is serialized with provider operations. A different Google subject cannot use an existing binding.

Google documents client_secret as optional for this flow. This implementation uses public-client PKCE without one; compatibility with the actual registered client has **not** been live tested. If the configured client refuses this exchange, keep the feature disabled and report the sanitized code. Do not embed a confidential secret as a workaround.

Consent Testing/verification and refresh-token restrictions must be checked in the actual Console before release. Test cross-device `drive.file` discovery explicitly; mock tests do not establish Google app authorization semantics. There is no Picker repair flow yet. A discovery failure is a blocked release gate.

Use Console quotas and billing as authority. Request/byte counters are diagnostic measurements, not a billing guarantee or a complete quota budget guard. Do not assume the API is unconditionally free for every project.

Official references verified during implementation (2026-10-28): [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [change feed](https://developers.google.com/workspace/drive/api/guides/manage-changes), [quotas](https://developers.google.com/workspace/drive/api/guides/limits).
