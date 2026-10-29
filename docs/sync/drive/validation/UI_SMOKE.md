# Native macOS smoke evidence

Isolated `com.vexor.nevis.drive-preview` debug application; no existing user Vault opened and no Google authorization granted.

- Launch and initial picker: PASS.
- Open Drive setup from Account: PASS.
- Missing Google client ID message + disabled sign-in: PASS.
- Correct centered modal after first UI correction: PASS.
- Escape closes modal and returns to picker: PASS.
- Persian/RTL layout and labels: PASS; drive-setup-fa.png.
- GitHub/legacy settings still reachable: PASS.
- Attempted local Vault creation in /tmp/nevis-drive-ui-smoke: OS picker automation timed out. Not counted as local-save success or an application failure; no Open/confirm action was issued for a real user directory.

No connected-account, remote transfer or resolved-conflict UI success is claimed by this smoke test.

## Final rebuild — 2026-10-29

The final source was packaged again successfully. Retesting through CUA could not reach a native window: bundle-ID lookup returned noWindowsAvailable, the optional launch_app API was unavailable, and full-path lookup timed out. These are automation limitations; they do not prove an application launch failure or a GUI PASS. The earlier screenshot/setup observations are not relabeled as final connected UI evidence. No real user Vault or Google authorization was used.

## Corrected OAuth Preview — observed later on 2026-10-29

CUA bundle-ID lookup was ambiguous because three Preview copies exist. Selecting the exact delivered full path succeeded. The native welcome window was visible; clicking Sign in or create account opened the Google Drive Sync dialog. Experimental notice, Signed out, Import Desktop OAuth JSON, Sign in with Google, diagnostics and GitHub settings were visible. No credential import, Google consent grant, Vault creation or remote data operation was performed by automation. User reported the old sign-in failed; corrected-build sign-in is still pending.

## Direct saved-secret entry — same day

The new delivered Preview opened by its exact full path. Welcome → Drive dialog → Enter saved client secret revealed an AX secure text field and Save client secret securely. Clicking save with an empty field displayed the expected safe validation message; no real value was entered and no credential was saved. The dialog was closed/reopened to clear the test message, then the empty secret entry was left expanded for the user. This proves the native IPC validation/UI path for empty input, not successful Keychain storage or Google sign-in.

## Publisher-configured Preview

Exact-path launch and welcome → Drive dialog succeeded. The first status read remained Loading; a native stack sample showed repeated calls blocked in SecKeychainFindGenericPassword. No successful retained-session or completed dialog is claimed from that run. Status was subsequently made one asynchronous generation-protected read, with explicit checking/error state and no per-poll thread accumulation. Unit regression passed; final GUI completion is pending. Source/customer configuration hides and gates JSON/manual setup; packaged parameter presence and log redaction were separately verified. No OS credential-store permission or signing check was bypassed.

Later in the publisher-build GUI smoke, the Keychain read completed: the previously signed-in identity and Reconnect Google were visible, with no Secret or JSON setup controls. No Vault was open. This verifies a basic stored-account reload and the normal customer UI in that build; it does not verify automatic token refresh or two-device transfer. The following single-flight status change has unit regression coverage; no full connected GUI certification is claimed.
