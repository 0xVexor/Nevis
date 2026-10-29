#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildPlan(root, platform = process.platform) {
  const app = path.join(root, 'spike/tiptap')
  const target = path.join(app, 'src-tauri/target')
  const wrapper = path.join(root, '.github/scripts/build-github-preview.mjs')
  const collector = path.join(root, '.github/scripts/collect-github-preview.mjs')
  if (platform === 'darwin') return [
    ['rustup', ['target', 'add', 'aarch64-apple-darwin', 'x86_64-apple-darwin'], root],
    [process.execPath, [wrapper, '--target', 'universal-apple-darwin', '--bundles', 'app'], root],
    ['bash', [path.join(root, '.github/scripts/build-github-preview-installer.sh'), path.join(target, 'universal-apple-darwin/release/bundle/macos/Nevis GitHub Preview.app'), path.join(root, 'artifacts/github-preview/Nevis-GitHub-Preview.pkg')], root],
    [process.execPath, [collector, 'macos', path.join(root, 'artifacts/github-preview/Nevis-GitHub-Preview.pkg')], root],
  ]
  if (platform === 'win32') return [
    ['rustup', ['toolchain', 'install', 'stable-x86_64-pc-windows-msvc', '--profile', 'minimal'], root],
    [process.execPath, [wrapper, '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'], root],
    [process.execPath, [collector, 'windows'], root],
  ]
  throw new Error('Local installers require macOS or Windows. Use --both for the GitHub build runners.')
}
function run(command, args, cwd, capture = false, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' })
  if (result.error) throw new Error(`${command}: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}).${capture ? '\n' + result.stderr : ''}`)
  return result.stdout?.trim() ?? ''
}
export async function main(args = process.argv.slice(2)) {
  const supported = ['--both', '--dry-run', '--help', '--no-wait']
  if (args.some(a => !supported.includes(a))) throw new Error('Unknown option. Use --help.')
  if (args.includes('--help')) {
    console.log(`Build Nevis from the current checkout, without merging or installing it.\n\nnode scripts/build-desktop.mjs             Local macOS Universal .pkg or Windows x64 .exe\nnode scripts/build-desktop.mjs --both      Build both on GitHub, wait, download artifacts\nnode scripts/build-desktop.mjs --both --no-wait   Queue both and print the Actions link\nnode scripts/build-desktop.mjs --dry-run   Show the plan without installing/building/pushing\n\nLocal: Node.js 22.12+ (or 24+), Rust/rustup, OS Tauri build prerequisites.\nBoth: Git, GitHub CLI (gh auth login), a clean commit, and origin push access.\nOutput: artifacts/github-preview/. The test app has a separate identifier and credential store.`)
    return
  }
  const dry = args.includes('--dry-run'), both = args.includes('--both')
  const root = run('git', ['rev-parse', '--show-toplevel'], process.cwd(), true)
  if (!existsSync(path.join(root, 'spike/tiptap/src-tauri/tauri.github-preview.conf.json'))) throw new Error('Run from a Nevis checkout containing the desktop build scripts.')
  const branch = run('git', ['branch', '--show-current'], root, true) || 'detached'
  const commit = run('git', ['rev-parse', 'HEAD'], root, true)
  console.log(`Source: ${branch} @ ${commit}`)
  if (both) {
    const dirty = run('git', ['status', '--porcelain'], root, true)
    if (dirty && !dry) throw new Error('Commit your changes before --both. Remote builds use the exact committed source; local builds can include uncommitted changes.')
    const buildBranch = `build/desktop/${commit.slice(0, 7)}-${Date.now()}`
    const push = ['push', 'origin', `${commit}:refs/heads/${buildBranch}`]
    if (dry) { console.log(JSON.stringify({ mode: 'both', push: ['git', ...push], wait: !args.includes('--no-wait'), dirty: !!dirty, output: 'artifacts/github-preview/downloads/' }, null, 2)); return }
    const workflow = path.join(root, '.github/workflows/github-sync-preview.yml')
    if (!existsSync(workflow) || !readFileSync(workflow, 'utf8').includes('build/desktop/**')) throw new Error('This branch needs the current desktop build workflow before --both can run.')
    const origin = run('git', ['remote', 'get-url', 'origin'], root, true).replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')
    const url = new URL(origin)
    const name = url.pathname.replace(/^\/|\/$/g, '')
    if (!['http:', 'https:'].includes(url.protocol) || name.split('/').length !== 2) throw new Error('origin must point to a GitHub repository.')
    const repo = `${url.hostname}/${name}`
    run('gh', ['auth', 'status', '--hostname', url.hostname], root)
    // A dedicated, new build ref works before this workflow is merged into the default branch.
    // No checkout, commit, force-push, merge, release or tag is made by this script.
    run('git', push, root)
    console.log(`Build branch: ${buildBranch}\nhttps://${url.hostname}/${name}/actions?query=${encodeURIComponent('branch:' + buildBranch)}`)
    if (args.includes('--no-wait')) return
    let build
    for (let attempt = 0; attempt < 30 && !build; attempt++) {
      const rows = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--branch', buildBranch, '--json', 'databaseId,workflowName,url', '--limit', '20'], root, true))
      build = rows.find(r => r.workflowName === 'GitHub sync test installers')
      if (!build) await new Promise(resolve => setTimeout(resolve, 4000))
    }
    if (!build) throw new Error('The build ref was pushed, but the run is not visible yet. Open the Actions link above. The checkout must contain the preview workflow.')
    console.log(build.url)
    run('gh', ['run', 'watch', String(build.databaseId), '--repo', repo, '--exit-status'], root)
    const output = path.join(root, 'artifacts/github-preview/downloads', buildBranch.split('/').at(-1))
    run('gh', ['run', 'download', String(build.databaseId), '--repo', repo, '--dir', output], root)
    console.log(`Installers, BUILD-INFO and SHA256SUMS: ${output}`)
    return
  }
  if (args.includes('--no-wait')) throw new Error('--no-wait requires --both.')
  if (process.platform === 'win32' && process.arch !== 'x64') throw new Error('The local Windows builder requires x64. Use --both for Windows x64 and macOS Universal.')
  const plan = buildPlan(root)
  if (dry) { console.log(JSON.stringify({ mode: 'local', platform: process.platform, commands: plan, output: 'artifacts/github-preview/' }, null, 2)); return }
  run('cargo', ['--version'], root)
  const app = path.join(root, 'spike/tiptap')
  if (!existsSync(path.join(app, 'node_modules/@tauri-apps/cli/tauri.js'))) {
    if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'npm ci'], app)
    else run('npm', ['ci'], app)
  }
  const env = { ...process.env, CARGO_TARGET_DIR: path.join(app, 'src-tauri/target'), NOVIQ_PREVIEW_TARGET_DIR: path.join(app, 'src-tauri/target') }
  for (const [command, argv, cwd] of plan) run(command, argv, cwd, false, env)
  console.log(`Installers, BUILD-INFO and SHA256SUMS: ${path.join(root, 'artifacts/github-preview')}`)
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode = 1 })
