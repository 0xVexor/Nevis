import type { Editor } from '@tiptap/core'
import { Icon, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSep } from './design-system'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import { useAnchor } from './editor/useAnchor'
import { openLightbox } from './editor/lightbox'
import { t } from './i18n'

const WIDTHS = [25, 50, 75, 100]

function B({ icon, title, on, danger, text, onClick }: { icon: ReactNode; title: string; on?: boolean; danger?: boolean; text?: boolean; onClick: () => void }) {
  return (
    <ToolbarButton label={title} pressed={on} danger={danger} text={text} onClick={onClick}>
      {icon}
    </ToolbarButton>
  )
}
const Group = ToolbarGroup

/** Floating toolbar over the selected image: size, position, enlarge, remove (same look as the table toolbar). */
export function ImageBubble({ editor }: { editor: Editor }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const sel = e?.state.selection
      if (!e || !e.isEditable || !(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return null
      return { pos: sel.from, w: sel.node.attrs.width ?? null, align: sel.node.attrs.align ?? null }
    },
  })
  const box = useAnchor(editor, !!s, () => (s ? ((editor.view.nodeDOM(s.pos) as HTMLElement | null)?.querySelector('img, video') ?? (editor.view.nodeDOM(s.pos) as HTMLElement | null)) : null), [
    s?.pos,
    s?.w,
    s?.align,
  ])
  if (!s) return null
  const set = (patch: Record<string, unknown>) => editor.chain().focus().updateAttributes('image', patch).run()
  const enlarge = () => {
    const img = (editor.view.nodeDOM(s.pos) as HTMLElement | null)?.querySelector('img')
    if (img?.src) openLightbox({ src: img.src, alt: img.alt })
  }
  return createPortal(
    <Toolbar ref={box} label={t('Image')} style={{ position: 'fixed', zIndex: 'var(--ds-z-float)' }} onMouseDown={(e) => e.preventDefault()}>
      <Group label={t('Size')}>
        {WIDTHS.map((w) => (
          <B key={w} icon={<>{w}%</>} text title={t('Width {w}%', { w })} on={s.w === w} onClick={() => set({ width: w })} />
        ))}
        <B icon={<Icon name="refresh" size={16} />} title={t('Original size')} on={s.w == null} onClick={() => set({ width: null })} />
      </Group>
      <ToolbarSep />
      <Group label={t('Position')}>
        <B icon={<Icon name="align-left" size={16} />} title={t('Align left')} on={s.align === 'left'} onClick={() => set({ align: s.align === 'left' ? null : 'left' })} />
        <B icon={<Icon name="align-center" size={16} />} title={t('Center')} on={s.align === 'center'} onClick={() => set({ align: s.align === 'center' ? null : 'center' })} />
        <B icon={<Icon name="align-right" size={16} />} title={t('Align right')} on={s.align === 'right'} onClick={() => set({ align: s.align === 'right' ? null : 'right' })} />
      </Group>
      <ToolbarSep />
      <Group label={t('Image')}>
        <B icon={<Icon name="maximize" size={16} />} title={t('Enlarge')} onClick={enlarge} />
        <B icon={<Icon name="trash" size={16} />} title={t('Remove image')} danger onClick={() => editor.chain().focus().deleteSelection().run()} />
      </Group>
    </Toolbar>,
    document.body,
  )
}
