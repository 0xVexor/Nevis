import test from 'node:test'
import assert from 'node:assert/strict'
import { compareLines, conflictVersion } from '../src/conflictDiff'
const encode = v => Buffer.from(JSON.stringify(v)).toString('base64')
test('insertion aligns later unchanged lines and preserves all text on both sides', () => {
  const a = 'عنوان\nfirst\nlast', b = 'عنوان\nfirst\ninserted\nlast'
  const rows = compareLines(a,b)
  assert.deepEqual(rows.find(r=>r.right==='inserted'),{left:null,right:'inserted',changed:true})
  assert.equal(rows.at(-1).changed,false)
  assert.equal(rows.filter(r=>r.left!==null).map(r=>r.left).join('\n'),a)
  assert.equal(rows.filter(r=>r.right!==null).map(r=>r.right).join('\n'),b)
})
test('changed lines and large-note fallback preserve exact versions', () => {
  assert.deepEqual(compareLines('a\nold\nz','a\nnew\nz')[1],{left:'old',right:'new',changed:true})
  const a=Array.from({length:1000},(_,i)=>String(i)).join('\n'),b=a+'\nnew'
  const rows=compareLines(a,b)
  assert.equal(rows.filter(r=>r.left!==null).map(r=>r.left).join('\n'),a)
  assert.equal(rows.filter(r=>r.right!==null).map(r=>r.right).join('\n'),b)
})
test('readable note preview keeps complete raw metadata and handles missing, binary and invalid data', () => {
  const note={title:'سلام',values:{status:'draft'},content:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'hello'}]},{type:'paragraph',content:[{type:'text',text:'world'}]}]}}
  const view=conflictVersion(encode(note))
  assert.equal(view.title,'سلام');assert.equal(view.text,'hello\nworld');assert.deepEqual(JSON.parse(view.raw),note)
  assert.equal(conflictVersion(null).text,'')
  assert.equal(conflictVersion('/w==').binary,true)
  assert.equal(conflictVersion('%%%').binary,true)
  const record={id:'db1',values:{a:1,b:2}}
  assert.deepEqual(JSON.parse(conflictVersion(encode(record)).text),record)
})
