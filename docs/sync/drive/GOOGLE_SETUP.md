# Publisher Google configuration and live verification

Customers install Nevis and select **Sign in with Google**. They do not create Google Cloud clients, download JSON, or enter client secrets. Account access/refresh tokens remain in the OS credential store and survive restarts until revoked or disconnected.

## Publisher build setup

1. Configure the publisher's Google project, Drive API, consent/branding/audience and Desktop client. Use the same publisher project/app and platform-appropriate Desktop client identities; verify cross-device drive.file discovery with those actual clients.
2. Put only the public `clientId` in `src-tauri/google-oauth.public.json` (or override `NEVIS_GOOGLE_CLIENT_ID`). That JSON rejects other fields.
3. Supply `NEVIS_GOOGLE_DESKTOP_CLIENT_SECRET` from the publisher's local/CI build environment. Do not commit the value or account tokens. On this Mac, `build:drive-preview` can capture the already saved developer `desktop-client:<clientId>` Keychain item in memory without printing it. This is a build-machine convenience, not a customer runtime dependency.
4. Run `npm run build:drive-preview -- --debug --bundles app` from `spike/tiptap`. Windows requires the platform's publisher configuration through the build environment and MSVC, as enforced by the helper. An enabled customer Drive build fails if publisher ID/parameter is missing.

The native build generates a client parameter constant under ignored Cargo OUT_DIR, then packages it in the executable. It is intentionally distributed with this **Desktop public client** and can be extracted from generated build material/the binary. Google explicitly says Desktop apps cannot keep client secrets confidential and require PKCE. This parameter is not a backend/server secret or an account token, and does not replace per-request PKCE/state or user consent. Never ship account access/refresh tokens, service-account keys or confidential web-client credentials. [Google Desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

The generated parameter is not emitted through cargo:rustc-env or normal build output. The actual packaged binary was checked for the expected ID/parameter with only boolean results reported; build logs were checked not to contain the value. Build environments/caches contain build inputs and should be handled accordingly. No promise that a Desktop binary can conceal its publisher parameter is made.

Normal builds hide JSON/secret configuration controls and reject their native commands. `NEVIS_GOOGLE_DEVELOPER_SETUP=1` explicitly enables those tools for developer troubleshooting when no bundled parameter is available; do not distribute that mode as the customer UX. Bundled configuration takes precedence over an old local developer item. Customer sign-in never asks for that old item.

## Authentication and actual evidence

Scopes remain `openid email drive.file`. The system browser returns a state-validated callback on ephemeral 127.0.0.1; PKCE verifier/code remain transient. Code exchange and refresh include the bundled Desktop client parameter. Only each user's tokens/identity go to Keychain/Credential Manager; there is no plaintext token fallback. Logout deletes the user token item, while publisher configuration remains in the app.

The first secret-less Preview failed with `client_secret is missing`. The user then reported successful real Google sign-in after developer Keychain setup. The subsequent publisher-configured build removes that setup from customer UX. Successful automatic refresh, restart lifecycle, clean-device Google login, real cross-device discovery, Windows and complete connected workflows remain unverified until actually exercised. `releaseReady=false` and Drive remains off by default outside an explicitly enabled preview/build. OAuth success alone does not certify the sync implementation for release.

The user's Console screenshot showed existing secret viewing/download is unavailable. JSON/manual entry instructions were temporary developer recovery, not requirements for Nevis customers. No new Google client, secret rotation, scope expansion or account permission change was performed here.

Use disposable Vaults for remaining real transfer/conflict/history tests. Request/byte counters cover worker requests on this installation; manual setup/history/repair and OAuth are not a complete quota/billing ledger. Use Google Console quotas as authority.

Account status checks are single-flight and asynchronous. They expose a checking state without blocking the whole account dialog or spawning a new Keychain read on every poll. A generation guard prevents an old read from restoring a logged-out identity. Save/logout update the cached identity only after the corresponding OS-store operation succeeds. The actual new debug app encountered a blocked native Keychain read during smoke testing; no retained-session success is claimed for that launch. Stable release signing/OS Keychain permissions remain a verification gate, and no Keychain ACL was weakened to bypass it.

Later in the publisher-build GUI smoke, the Keychain read completed: the previously signed-in identity and Reconnect Google were visible, with no Secret or JSON setup controls. No Vault was open. This verifies a basic stored-account reload and the normal customer UI in that build; it does not verify automatic token refresh or two-device transfer. The following single-flight status change has unit regression coverage; no full connected GUI certification is claimed.
