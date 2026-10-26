const fs = require('node:fs');
const key = (process.env.NEVIS_UPDATER_PUBLIC_KEY || '').trim();
if (!key) throw new Error('Set the NEVIS_UPDATER_PUBLIC_KEY repository variable before building updates.');
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Set the TAURI_SIGNING_PRIVATE_KEY repository secret before building updates.');
// The private key stays in the environment; only the public key enters the app bundle.
fs.writeFileSync('spike/tiptap/src-tauri/tauri.updater.conf.json', JSON.stringify({
  bundle: { createUpdaterArtifacts: true },
  plugins: { updater: { pubkey: key } },
}, null, 2) + '\n');
