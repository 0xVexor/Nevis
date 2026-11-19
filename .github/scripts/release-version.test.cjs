const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const checker = path.join(__dirname, 'release-version.cjs');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'nevis-version-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Release tests');
  git('config', 'user.email', 'release-tests@example.invalid');
  const write = (name, value) => {
    const file = path.join(cwd, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const version = (v) => {
    write('spike/tiptap/package.json', { name: 'nevis', version: v });
    write('spike/tiptap/package-lock.json', { name: 'nevis', version: v, packages: { '': { name: 'nevis', version: v } } });
    write('spike/tiptap/src-tauri/tauri.conf.json', { productName: 'Nevis', version: v });
    write('spike/tiptap/src-tauri/Cargo.toml', `name = "nevis"\nversion = "${v}"\n`);
    write('spike/tiptap/src-tauri/Cargo.lock', `[[package]]\nname = "nevis"\nversion = "${v}"\n`);
    write(`docs/releases/v${v}.md`, `Nevis ${v}\n`);
  };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'Fixture'); return git('rev-parse', 'HEAD'); };
  version('1.1.0');
  const main = commit();
  git('update-ref', 'refs/remotes/origin/main', main);
  version('1.2.0-beta.7');
  const dev = commit();
  git('update-ref', 'refs/remotes/origin/dev', dev);
  version('1.0.0');
  const reset = { version: '1.0.0', bases: {
    'origin/main': { version: '1.1.0', commit: main },
    'origin/dev': { version: '1.2.0-beta.7', commit: dev },
  } };
  const manifest = () => write('docs/releases/version-reset-1.0.0.json', reset);
  manifest();
  const check = (env) => spawnSync(process.execPath, [checker], { cwd, encoding: 'utf8', env: {
    ...process.env, GITHUB_REF_TYPE: 'branch', REQUIRE_AHEAD_OF: '', REQUIRE_VERSION_INCREASE: '', ...env,
  } });
  return { cwd, git, version, reset, manifest, commit, check };
}

test('the approved initial reset is allowed against the exact previous dev and main refs', (t) => {
  const f = fixture(t);
  for (const env of [{ REQUIRE_AHEAD_OF: 'origin/dev' }, { REQUIRE_VERSION_INCREASE: '1' }]) {
    const result = f.check(env);
    assert.equal(result.status, 0, result.stderr);
  }
});

test('an ordinary downgrade without the reset record is refused', (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.cwd, 'docs/releases/version-reset-1.0.0.json'));
  assert.notEqual(f.check({ REQUIRE_AHEAD_OF: 'origin/dev' }).status, 0);
  assert.notEqual(f.check({ REQUIRE_VERSION_INCREASE: '1' }).status, 0);
});

test('matching only a previous version is not enough: the exact base commit must match', (t) => {
  const f = fixture(t);
  f.reset.bases['origin/dev'].commit = '0'.repeat(40);
  f.reset.bases['origin/main'].commit = '0'.repeat(40);
  f.manifest();
  assert.notEqual(f.check({ REQUIRE_AHEAD_OF: 'origin/dev' }).status, 0);
  assert.notEqual(f.check({ REQUIRE_VERSION_INCREASE: '1' }).status, 0);
});

test('the reset cannot be used again after the base branch reaches 1.0.0', (t) => {
  const f = fixture(t);
  const current = f.commit();
  f.git('update-ref', 'refs/remotes/origin/dev', current);
  f.git('update-ref', 'refs/remotes/origin/main', current);
  assert.notEqual(f.check({ REQUIRE_AHEAD_OF: 'origin/dev' }).status, 0);
  assert.notEqual(f.check({ REQUIRE_VERSION_INCREASE: '1' }).status, 0);
  f.version('1.0.1');
  assert.equal(f.check({ REQUIRE_AHEAD_OF: 'origin/dev' }).status, 0);
  assert.equal(f.check({ REQUIRE_VERSION_INCREASE: '1' }).status, 0);
});

test('an approved reset still has to contain the base branch', (t) => {
  const f = fixture(t);
  const tree = f.git('rev-parse', 'HEAD^{tree}');
  const unrelated = f.git('commit-tree', tree, '-m', 'Unrelated');
  f.git('update-ref', 'refs/remotes/origin/dev', unrelated);
  f.reset.bases['origin/dev'].commit = unrelated;
  f.manifest();
  assert.notEqual(f.check({ REQUIRE_AHEAD_OF: 'origin/dev' }).status, 0);
});
