import type { Editor } from '@tiptap/core'
import { isSafeHref } from '@nevis/schema'
import { alertDialog, promptDialog } from '../dialog'
import { t } from '../i18n'

export async function editLink(editor: Editor) {
  const href = await promptDialog({ title: t('Link'), message: t('Link URL (empty = remove link)'), initial: editor.getAttributes('link').href || '', placeholder: 'https://', ltr: true })
  if (href === null || editor.isDestroyed || !editor.isEditable) return
  const url = href.trim()
  if (url && !isSafeHref(url)) return alertDialog({ title: t('This address is not allowed') })
  const chain = editor.chain().focus().extendMarkRange('link')
  if (url) chain.setLink({ href: url }).run()
  else chain.unsetLink().run()
}
