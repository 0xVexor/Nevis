const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const root = 'spike/tiptap/';
const app = JSON.parse(fs.readFileSync(root + 'package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync(root + 'package-lock.json', 'utf8'));
const tauri = JSON.parse(fs.readFileSync(root + 'src-tauri/tauri.conf.json', 'utf8'));
const cargo = fs.readFileSync(root + 'src-tauri/Cargo.toml', 'utf8');
const cargoLock = fs.readFileSync(root + 'src-tauri/Cargo.lock', 'utf8');
function requireThat(value, message) { if (!value) throw new Error(message); }
const version = app.version;
const stable = /^\d+\.\d+\.\d+$/.test(version);
const preview = /^\d+\.\d+\.\d+-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*$/.test(version);
requireThat(stable || (process.env.ALLOW_PRERELEASE === '1' && preview), 'Use X.Y.Z for stable releases, or an allowed X.Y.Z-beta.N prerelease.');
requireThat(app.name === 'nevis' && tauri.productName === 'Nevis', 'Product metadata must use Nevis.');
requireThat(lock.version === version && lock.packages[''].version === version && lock.name === app.name && lock.packages[''].name === app.name, 'App package lock is out of date.');
requireThat(tauri.version === version, 'Tauri version does not match package.json.');
requireThat(cargo.match(/^name\s*=\s*"([^"]+)"/m)?.[1] === 'nevis', 'Rust package must be named nevis.');
requireThat(cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] === version, 'Cargo.toml version does not match package.json.');
requireThat(cargoLock.match(/\[\[package\]\]\r?\nname = "nevis"\r?\nversion = "([^"]+)"/)?.[1] === version, 'Cargo.lock version does not match package.json.');
requireThat(fs.existsSync('docs/releases/v' + version + '.md'), 'Missing release notes for v' + version + '.');
if (process.env.GITHUB_REF_TYPE === 'tag') requireThat(process.env.GITHUB_REF_NAME === 'v' + version, 'The release tag does not match the app version.');
if (process.env.REQUIRE_VERSION_INCREASE === '1') {
  const previous = JSON.parse(execFileSync('git', ['show', 'origin/main:' + root + 'package.json'], {encoding:'utf8'})).version;
  const nextParts = version.split('.').map(Number);
  const oldParts = previous.split('.').map(Number);
  const different = nextParts.findIndex((n, i) => n !== oldParts[i]);
  requireThat(different >= 0 && nextParts[different] > oldParts[different], 'A release into main must increase the stable version.');
}
console.log('Nevis ' + version + ': release metadata is consistent.');
