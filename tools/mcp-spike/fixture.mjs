/** Create only synthetic data beneath /tmp; never adopt a personal vault for acceptance. */
import { mkdir, writeFile, access } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2] ?? `/tmp/nevis-mcp-acceptance/${Date.now()}`)
if (!root.startsWith('/tmp/nevis-mcp-acceptance/')) throw new Error('Use a new directory beneath /tmp/nevis-mcp-acceptance/')
try { await access(root); throw new Error('Refuse to overwrite an existing fixture') } catch (error) { if (error.code !== 'ENOENT') throw error }
const vaultPath = join(root, 'vault'), vaultId = randomUUID(), documentId = randomUUID(), rootId = randomUUID(), excludedId = randomUUID()
const node = (type, blockId, content = [], attrs = {}) => ({ type, attrs: { blockId, ...attrs }, content })
const paragraph = (id, text) => node('paragraph', id, text ? [{ type: 'text', text }] : [], { dir: 'rtl' })
const cell = (id, text, attrs = {}) => node('tableCell', id, [paragraph(`${id}-p`, text)], { rowspan: 1, colspan: 1, ...attrs })
const base = { tags: ['mcp-fixture'], favorite: false, sort: 0, updatedAt: 1, deletedAt: null }
const doc = content => ({ type: 'doc', attrs: { blockIdentityVersion: 1 }, content })
const pages = [
 { ...base, id: rootId, parentId: null, kind: 'folder', title: 'Allowed acceptance', content: doc([paragraph('folder-p', '')]) },
 { ...base, id: documentId, parentId: rootId, title: 'MCP acceptance فارسی Java', content: doc([
  node('heading', 'heading', [{ type: 'text', text: 'هدف acceptance' }], { level: 2 }), paragraph('paragraph', 'متن فارسی Java محفوظ'),
  node('table', 'table', [node('tableRow', 'row1', [cell('cell1', 'فارسی', { rowspan: 2, colwidth: [140] }), cell('cell2', 'Java', { colspan: 2, colwidth: [100, 120] })]), node('tableRow', 'row2', [cell('cell3', 'RTL'), cell('cell4', 'LTR')])]),
 ]) },
 { ...base, id: excludedId, parentId: rootId, title: 'Excluded fixture sentinel', content: doc([paragraph('private-p', 'PRIVATE_SENTINEL_DO_NOT_DISCLOSE')]) },
]
await mkdir(join(vaultPath, '.noviq'), { recursive: true }); await mkdir(join(vaultPath, 'pages'))
await writeFile(join(vaultPath, '.noviq/vault.json'), JSON.stringify({ format: 1, id: vaultId, name: 'MCP disposable acceptance' }))
for (const page of pages) await writeFile(join(vaultPath, 'pages', `${page.id}.json`), JSON.stringify(page))
await writeFile(join(root, 'fixture.json'), JSON.stringify({ vaultId, documentId, rootId, excludedId, vaultPath }, null, 2))
await writeFile(join(root, 'registry.json'), JSON.stringify({ current: vaultId, vaults: [{ id: vaultId, name: 'MCP disposable acceptance', path: vaultPath, sync: false }] }))
console.log(root)
