// Set the app version in every file that carries it, then run the release check.
//   node .github/scripts/bump-version.cjs 1.1.0-beta.19     (pre-release)
//   node .github/scripts/bump-version.cjs 1.2.0             (final release)
// It edits text in place so line endings and formatting stay as they are, and it
// starts the release notes from the previous notes if the new ones do not exist yet.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const version = process.argv[2];
const valid = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (!version || !valid.test(version)) {
  console.error('Usage: node .github/scripts/bump-version.cjs X.Y.Z[-beta.N]');
  process.exit(1);
}

const root = 'spike/tiptap/';
const read = (file) => fs.readFileSync(file, 'utf8');
const current = JSON.parse(read(root + 'package.json')).version;
if (current === version) {
  console.error(`The app is already at ${version}.`);
  process.exit(1);
}

// Each edit must change exactly the number of places it expects, or nothing is written.
const edits = [
  [root + 'package.json', /^(\s*"version":\s*")[^"]+(")/m, 1],
  [root + 'package-lock.json', /("name":\s*"nevis",\s*"version":\s*")[^"]+(")/g, 2],
  [root + 'src-tauri/tauri.conf.json', /^(\s*"version":\s*")[^"]+(")/m, 1],
  [root + 'src-tauri/Cargo.toml', /^(\[package\][^[]*?\nversion\s*=\s*")[^"]+(")/, 1],
  [root + 'src-tauri/Cargo.lock', /(\[\[package\]\]\r?\nname = "nevis"\r?\nversion = ")[^"]+(")/, 1],
];

const pending = edits.map(([file, pattern, expected]) => {
  const text = read(file);
  const found = (text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')) ?? []).length;
  if (found !== expected) throw new Error(`${file}: expected ${expected} version field(s), found ${found}.`);
  return [file, text.replace(pattern, `$1${version}$2`)];
});
for (const [file, text] of pending) fs.writeFileSync(file, text);

const notes = `docs/releases/v${version}.md`;
if (!fs.existsSync(notes)) {
  const earlier = fs.readdirSync('docs/releases').filter((f) => f === `v${current}.md`);
  const heading = '# Nevis ' + version.replace(/-beta\.(\d+)/, ' beta $1') + '\n\n';
  const body = earlier.length
    ? read('docs/releases/' + earlier[0]).replace(/^# .*\n+/, '')
    : '## What’s new\n\n- \n';
  fs.writeFileSync(notes, heading + body);
  console.log(`Created ${notes} from the previous notes. Rewrite it for this version.`);
}

console.log(`Version ${current} -> ${version}`);
execFileSync('node', ['.github/scripts/release-version.cjs'], {
  stdio: 'inherit',
  env: { ...process.env, ALLOW_PRERELEASE: /-/.test(version) ? '1' : '0' },
});
