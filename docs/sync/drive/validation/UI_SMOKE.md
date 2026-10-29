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
