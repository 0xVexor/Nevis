import { createEditor } from '@nevis/editor'
import type * as Y from 'yjs'
import type { Workspace } from '../workspace'
import { referenceEditorExtensions } from './extensions'
import { t } from '../i18n'

/** Every document surface uses the same controls and the workspace's attachment store. */
export function createWorkspaceEditor(ws: Workspace, doc: Y.Doc, host: HTMLElement, ownFindBar = true) {
  return createEditor(doc, host, {
    pages: () => ws.pageList(),
    onOpenPage: id => ws.onOpenPage?.(id),
    onCreateLinkedPage: title => ws.newPage('', title),
    placeholder: () => t('Start writing, or press / for commands.'),
    notify: message => ws.notify(message),
    attachments: ws.rt.attachments,
    ownFindBar,
    uiExtensions: referenceEditorExtensions(() => ws.pageList()),
    editDrawing: (json, max) => import('../DrawingModal').then(module => module.openDrawingEditor(json, max, message => ws.notify(message))),
  })
}
