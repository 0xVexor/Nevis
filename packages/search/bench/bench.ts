// pnpm --filter @nevis/search bench — ADR-0010's numbers: 10 000 synthetic pages (about 800 words, 70% Persian).
import { SearchIndex } from '../src'
const N = Number(process.env.PAGES ?? 10_000)
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
const fa = Array.from({ length: 4000 }, (_, i) => { let w = ''; const n = 2 + (i % 6); for (let k = 0; k < n; k++) w += String.fromCharCode(0x0627 + ((i * 7 + k * 13 + (i >> 3)) % 40)); return i % 9 === 0 ? w.slice(0, 2) + '‌' + w.slice(2) : w })
const en = Array.from({ length: 3000 }, (_, i) => { let w = ''; const n = 3 + (i % 7); for (let k = 0; k < n; k++) w += String.fromCharCode(97 + ((i * 5 + k * 11 + (i >> 2)) % 26)); return w })
const page = (i: number) => {
  const words: string[] = []
  for (let k = 0; k < 800; k++) words.push(rnd() < 0.7 ? fa[Math.floor(rnd() * rnd() * fa.length)]! : en[Math.floor(rnd() * rnd() * en.length)]!)
  return { id: `p${i}`, title: words.slice(0, 4).join(' '), body: words.join(' ') }
}
const docs = Array.from({ length: N }, (_, i) => page(i))
const heap = () => { global.gc?.(); return process.memoryUsage().heapUsed / 1048576 }
const h0 = heap()
let t = performance.now()
const idx = new SearchIndex(); idx.addAll(docs)
const build = (performance.now() - t) / 1000
const mem = heap() - h0
t = performance.now(); const text = idx.serialize(); const ser = (performance.now() - t) / 1000
t = performance.now(); const back = SearchIndex.load(text)!; const load = (performance.now() - t) / 1000
const qs = docs.slice(0, 400).map(d => d.body.split(' ')[10]!.slice(0, 3)).concat(['میخواهم', 'کتاب', 'abc'])
const times: number[] = []
for (const q of qs) { const s = performance.now(); back.search(q, 20); times.push(performance.now() - s) }
times.sort((a, b) => a - b)
console.log(JSON.stringify({ pages: N, buildSeconds: +build.toFixed(1), heapMB: +mem.toFixed(0), serializedMB: +(text.length / 1048576).toFixed(0), serializeSeconds: +ser.toFixed(1), loadSeconds: +load.toFixed(1), queryP50ms: +times[times.length >> 1]!.toFixed(1), queryP95ms: +times[Math.floor(times.length * 0.95)]!.toFixed(1) }))
