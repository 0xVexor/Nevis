import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { buildPlan } from './build-desktop.mjs'
const script=fileURLToPath(new URL('./build-desktop.mjs',import.meta.url))
test('native plans use isolated bundles, both Mac architectures and paths with spaces',()=>{
 const mac=buildPlan('/tmp/Nevis project','darwin'),win=buildPlan('C:/Nevis project','win32')
 assert.deepEqual(mac[0][1],['target','add','aarch64-apple-darwin','x86_64-apple-darwin'])
 assert.ok(mac[1][1].includes('universal-apple-darwin'))
 assert.ok(mac[2][1].some(a=>a.endsWith('Nevis GitHub Preview.app')))
 assert.ok(win[1][1].includes('nsis'))
 assert.ok(win[1][1].includes('x86_64-pc-windows-msvc'))
 assert.ok(mac.every(([,args])=>!args.includes('--release')))
 assert.throws(()=>buildPlan('/tmp','linux'),/--both/)
})
test('remote dry run uses current commit without changing refs; dirty remote build stops before tools/network',()=>{
 const root=mkdtempSync(path.join(tmpdir(),'nevis build script '))
 const git=args=>{const r=spawnSync('git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()}
 try{
  git(['init','-b','feature/reader-preview']);git(['config','user.name','Test']);git(['config','user.email','test@example.invalid'])
  mkdirSync(path.join(root,'spike/tiptap/src-tauri'),{recursive:true});writeFileSync(path.join(root,'spike/tiptap/src-tauri/tauri.github-preview.conf.json'),'{}')
  git(['add','.']);git(['commit','-m','test fixture']);const before=git(['show-ref'])
  const result=spawnSync(process.execPath,[script,'--both','--dry-run'],{cwd:root,encoding:'utf8'})
  assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/feature\/reader-preview/);assert.ok(result.stdout.includes(git(['rev-parse','HEAD'])))
  assert.match(result.stdout,/refs\/heads\/build\/desktop\//);assert.equal(git(['show-ref']),before)
  writeFileSync(path.join(root,'pending.txt'),'unsaved source')
  const dirty=spawnSync(process.execPath,[script,'--both'],{cwd:root,encoding:'utf8'})
  assert.notEqual(dirty.status,0);assert.match(dirty.stderr,/Commit your changes/);assert.equal(git(['show-ref']),before)
 }finally{rmSync(root,{recursive:true,force:true})}
})
