const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const release = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const version = require('../../spike/tiptap/package.json').version;
if (manifest.version.replace(/^v/, '') !== version) throw new Error('Updater version does not match the release.');
const assets = new Set(release.assets.map(a => a.browser_download_url));
for (const platform of ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
  const entry = manifest.platforms?.[platform];
  if (!entry?.signature?.trim() || !assets.has(entry.url)) throw new Error('Missing signed updater artifact for ' + platform);
  if (!entry.url.startsWith(`https://github.com/${process.env.GITHUB_REPOSITORY}/releases/download/${release.tag_name}/`)) throw new Error('Updater URL points outside this release.');
}
console.log('Signed updater assets exist for every supported platform.');
