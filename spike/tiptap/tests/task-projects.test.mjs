import assert from 'node:assert/strict'
import test from 'node:test'
import { buildIndex } from '../src/pageIndex.ts'
import { buildTaskProjects } from '../src/taskProjects.ts'

const page = (id, parentId, kind, extra = {}) => ({ id, parentId, kind, sort: 0, ...extra })

test('top-level projects include nested notes and lists, and count only open tasks', () => {
  const index = buildIndex([
    page('nevis', null, 'folder'),
    page('release', 'nevis', 'folder'),
    page('checklist', 'release', 'todo'),
    page('roadmap', 'nevis'),
    page('claims', null, 'folder'),
    page('triage', 'claims'),
    page('empty', null, 'folder'),
    page('scratch', null),
    page('row', 'release', undefined, { database: {} }),
  ])
  const { projects, projectByPage } = buildTaskProjects(index, [
    { pageId: 'checklist', checked: false },
    { pageId: 'checklist', checked: true },
    { pageId: 'roadmap', checked: false },
    { pageId: 'triage', checked: true },
    { pageId: 'scratch', checked: false },
    { pageId: 'row', checked: false },
  ])
  assert.deepEqual(projects.map(({ folder, open }) => [folder.id, open]), [['nevis', 2], ['claims', 0], ['empty', 0]])
  assert.equal(projectByPage.get('checklist'), 'nevis')
  assert.equal(projectByPage.get('triage'), 'claims')
  assert.equal(projectByPage.has('scratch'), false)
  assert.equal(projectByPage.has('row'), false)
})
