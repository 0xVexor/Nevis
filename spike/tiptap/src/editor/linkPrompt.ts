import type { Editor } from '@tiptap/core'
import { promptDialog } from '../dialog'
import { t } from '../i18n'

/** Add, change or remove the link on the selection (an empty address removes it). Shared by the toolbar and its shortcut. */
export function editLink(editor: Editor) {
  const prev = editor.getAttributes('link').href ?? ''
  void promptDialog({ title: t('Link'), message: t('Link URL (empty = remove link)'), initial: prev, placeholder: 'https://', ltr: true }).then((url) => {
    if (url === null) return
    const chain = editor.chain().focus()
    ;(url ? chain.setLink({ href: url }) : chain.unsetLink()).run()
  })
}
