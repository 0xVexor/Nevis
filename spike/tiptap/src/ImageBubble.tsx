import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useEditorState } from '@tiptap/react'
import { NodeSelection } from '@tiptap/pm/state'
import * as Ic from './icons'
import { useAnchor } from './editor/useAnchor'
import { openLightbox } from './editor/lightbox'
import { t } from './i18n'

const WIDTHS = [25, 50, 75, 100]

function B({ icon, title, on, danger, onClick }: { icon: ReactNode; title: string; on?: boolean; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={'tbb' + (on ? ' on' : '') + (danger ? ' danger' : '')} title={title} aria-label={title} aria-pressed={on} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>
      {icon}
    </button>
  )
}
const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="tbg" role="group" aria-label={label}>
    <span className="tbg-l">{label}</span>
    <div className="tbg-b">{children}</div>
  </div>
)

/** Floating toolbar over the selected image: size, position, enlarge, remove (same look as the table toolbar). */
export function ImageBubble({ editor }: { editor: any }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }: any) => {
      const sel = e?.state.selection
      if (!e || !e.isEditable || !(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return null
      return { pos: sel.from, w: sel.node.attrs.width ?? null, align: sel.node.attrs.align ?? null }
    },
  })
  const box = useAnchor(editor, !!s, () => (s ? ((editor.view.nodeDOM(s.pos) as HTMLElement | null)?.querySelector('img') ?? (editor.view.nodeDOM(s.pos) as HTMLElement | null)) : null), [s?.pos, s?.w, s?.align])
  if (!s) return null
  const set = (patch: Record<string, unknown>) => editor.chain().focus().updateAttributes('image', patch).run()
  const enlarge = () => {
    const img = (editor.view.nodeDOM(s.pos) as HTMLElement | null)?.querySelector('img')
    if (img?.src) openLightbox({ src: img.src, alt: img.alt })
  }
  return createPortal(
    <div ref={box} className="bubble tbl" dir="ltr" style={{ position: 'fixed', zIndex: 60 }} onMouseDown={(e) => e.preventDefault()}>
      <Group label={t('Size')}>
        {WIDTHS.map((w) => (
          <B key={w} icon={<span className="tbb-t">{w}%</span>} title={t('Width {w}%', { w })} on={s.w === w} onClick={() => set({ width: w })} />
        ))}
        <B icon={<Ic.Reset />} title={t('Original size')} on={s.w == null} onClick={() => set({ width: null })} />
      </Group>
      <Group label={t('Position')}>
        <B icon={<Ic.AlignLeft size={16} />} title={t('Align left')} on={s.align === 'left'} onClick={() => set({ align: s.align === 'left' ? null : 'left' })} />
        <B icon={<Ic.AlignCenter size={16} />} title={t('Center')} on={s.align === 'center'} onClick={() => set({ align: s.align === 'center' ? null : 'center' })} />
        <B icon={<Ic.AlignRight size={16} />} title={t('Align right')} on={s.align === 'right'} onClick={() => set({ align: s.align === 'right' ? null : 'right' })} />
      </Group>
      <Group label={t('Image')}>
        <B icon={<Ic.Enlarge />} title={t('Enlarge')} onClick={enlarge} />
        <B icon={<Ic.Trash size={16} />} title={t('Remove image')} danger onClick={() => editor.chain().focus().deleteSelection().run()} />
      </Group>
    </div>,
    document.body,
  )
}
