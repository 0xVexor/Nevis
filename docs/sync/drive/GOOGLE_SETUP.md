# Google configuration and live verification

Do not use a real Vault for initial validation. The implementation is experimental and has internal release gaps in addition to the missing OAuth/account tests.

1. In Google Cloud Console create/select one publisher project for both desktop platforms and enable Drive API.
2. Configure consent branding, audience and test users. Create an OAuth client of type **Desktop app**. Use the same publisher project/consent app; Google recommends a separate Desktop client per platform. Verify cross-device discovery with those actual clients.
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

`src-tauri/google-oauth.public.json` is loaded by build.rs and contains only the public `clientId`. `NEVIS_GOOGLE_CLIENT_ID` overrides it. The example file is a template. Run `npm run build:drive-preview -- --debug --bundles app` for the configured preview. The preview identifier is `com.vexor.nevis.drive-preview`; it uses separate app-data. Production Drive is disabled unless explicitly built with the flag. Do not enable a release merely because a preview connects.

Authentication opens the system browser and receives a state-validated callback on an ephemeral `127.0.0.1` listener. PKCE verifier stays in memory. Cancel/timeout/restart do not persist an authorization code. Tokens and subject/email are stored together in the OS credential store; there is no plaintext fallback. Keychain/Credential Manager failures stop sign-in. Refresh is serialized with provider operations. A different Google subject cannot use an existing binding.

Google documents `client_secret` as optional, but a live request with this configured Desktop client on 2026-10-29 returned `invalid_request: client_secret is missing`. The original Preview omitted it and therefore could not complete sign-in. For an existing client whose secret was saved, open **Enter saved client secret** in the corrected Preview, paste only that value and select **Save client secret securely**. The current Console no longer downloads existing secrets. If the original Desktop JSON was previously downloaded, **Import Desktop OAuth JSON** is an alternative. The native importer bounds the input to 64 KiB, requires `installed.client_id` to match the compiled public identity, and stores only `installed.client_secret` in the OS credential store under that identity. Neither JSON nor secret is copied to the repository, app data, or Vault. Both code exchange and refresh submit it over HTTPS alongside PKCE/the refresh token. Desktop client values are extractable public-client identifiers, not a substitute for PKCE or user tokens. Client configuration is a per-device setup step in this experimental build; public distribution without that step remains a packaging/product decision. Successful real sign-in and refresh are still NOT VERIFIED until the user retests.

Consent Testing/verification and refresh-token restrictions must be checked in the actual Console before release. Test cross-device `drive.file` discovery explicitly; mock tests do not establish Google app authorization semantics. There is no Picker repair flow yet. A discovery failure is a blocked release gate.

Use Console quotas and billing as authority. Request/byte counters are diagnostic measurements, not a billing guarantee or a complete quota budget guard. Do not assume the API is unconditionally free for every project.

Official references verified during implementation (2026-10-28): [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [change feed](https://developers.google.com/workspace/drive/api/guides/manage-changes), [quotas](https://developers.google.com/workspace/drive/api/guides/limits).

## Existing Desktop secret cannot be downloaded (user Console verified)

The user's current Google Cloud client detail page explicitly says viewing and downloading existing secrets is no longer available. Earlier instructions to download the existing client's JSON were incorrect for that page. No new client or secret rotation is needed if the original secret was saved. In the corrected Preview, open **Enter saved client secret**, paste only that saved value into the password field, select **Save client secret securely**, then sign in. The field is uncontrolled/transient, is cleared before the native call and when collapsed/unmounted, and is never put in localStorage/Vault data. The native command bounds/validates input, rejects a client ID or extra text, and stores it only in the same client-scoped OS keyring item used by JSON import. If a credential JSON was already downloaded earlier, import remains supported. No Google-side secret/client change was performed by this correction.
