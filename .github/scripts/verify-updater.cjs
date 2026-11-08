const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const release = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const version = require('../../spike/tiptap/package.json').version;
if (manifest.version.replace(/^v/, '') !== version) throw new Error('Updater version does not match the release.');
// Draft releases report temporary download URLs, so match assets by file name.
const assets = new Set(release.assets.map(a => a.name));
for (const platform of ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
  const entry = manifest.platforms?.[platform];
  const prefix = `https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${release.tag_name}/`;
  if (!entry?.url?.startsWith(prefix)) throw new Error('Updater URL points outside this release.');
  if (!entry.signature?.trim() || !assets.has(decodeURIComponent(entry.url.slice(prefix.length)))) throw new Error('Missing signed updater artifact for ' + platform);
}
console.log('Signed updater assets exist for every supported platform.');
