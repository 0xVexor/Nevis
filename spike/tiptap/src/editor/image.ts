import type { Editor } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { putFile, typeFor, urlFor } from '../attachments'
import { gifToVideo, isGif } from '../media/gif'
import { isVideo } from '../media/video'
import { openLightbox } from './lightbox'
import { t } from '../i18n'
import { setLabel, svgIcon } from './svgIcons'
import { promptDialog } from '../dialog'

type ImageAlign = 'left' | 'center' | 'right' | 'start' | 'end' // start/end: older pages, logical sides
const WIDTHS = [25, 50, 75, 100]

/**
 * Image node whose `src` is `att:<sha256>` (the NodeView resolves it from the local file store), with:
 *  - `width`: percent of the text column (null = natural size, never wider than the column)
 *  - `align`: start | center | end (logical, so it follows the page direction)
 * Hover/select shows a toolbar (sizes, alignment, enlarge, remove); the corner handle resizes by dragging;
 * double-click opens the zoom viewer.
 */
export const AttImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-w')) || null,
        renderHTML: (a: Record<string, unknown>) => (a.width ? { 'data-w': a.width } : {}),
      },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align'),
        renderHTML: (a: Record<string, unknown>) => (a.align ? { 'data-align': a.align } : {}),
      },
      // 'loop': a GIF that was stored as a short video; it plays muted and on repeat, like the GIF it came from
      motion: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-motion'),
        renderHTML: (a: Record<string, unknown>) => (a.motion ? { 'data-motion': a.motion } : {}),
      },
    }
  },
  addNodeView() {
    return ({ node, editor, getPos }) => {
      let cur = node
      let current = ''
      const fig = document.createElement('figure')
      fig.className = 'img-fig'
      const img = document.createElement('img')
      img.draggable = false // the figure is the draggable part (ProseMirror moves the whole node)
      img.title = t('Double-click to enlarge')
      // a stored video (an added video, or a GIF turned into a loop) is shown by a <video> in place of the <img>
      let media: HTMLImageElement | HTMLVideoElement = img
      const video = document.createElement('video')
      video.draggable = false
      video.preload = 'metadata'
      video.playsInline = true
      const showVideo = (loop: boolean) => {
        video.controls = !loop
        video.muted = loop
        video.loop = loop
        video.autoplay = loop
        if (media !== video) {
          img.replaceWith(video)
          media = video
        }
      }

      const setAttrs = (patch: Record<string, unknown>) => {
        const pos = getPos()
        if (pos == null || !editor.isEditable) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...patch }))
      }

      // ── toolbar ──
      const bar = document.createElement('div')
      bar.className = 'img-bar ds-toolbar'
      bar.contentEditable = 'false'
      const btn = (label: string, title: string, fn: () => void) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'ds-icon-btn ds-toolbar-btn' + (label.startsWith('<svg') ? '' : ' ds-toolbar-btn--text')
        setLabel(b, label)
        b.title = title
        b.onmousedown = (e) => e.preventDefault()
        b.onclick = fn
        return b
      }
      const sizeBtns = WIDTHS.map((w) => btn(`${w}%`, t('Width {w}%', { w }), () => setAttrs({ width: w === 100 ? 100 : w })))
      const reset = btn(svgIcon.reset, t('Original size'), () => setAttrs({ width: null }))
      // physical sides (what "left" and "right" mean on screen); clicking the active one returns to the natural position
      const aligns: [ImageAlign, string][] = [
        ['left', t('Align left')],
        ['center', t('Center')],
        ['right', t('Align right')],
      ]
      const alignBtns = aligns.map(([a, title]) =>
        btn({ left: svgIcon.left, center: svgIcon.center, right: svgIcon.right, start: '', end: '' }[a], title, () => setAttrs({ align: cur.attrs.align === a ? null : a })),
      )
      const big = btn(svgIcon.enlarge, t('Enlarge'), () => media === img && img.src && openLightbox({ src: img.src, alt: cur.attrs.alt }))
      big.classList.add('img-big')
      const del = btn(svgIcon.close, t('Remove image'), () => {
        const pos = getPos()
        if (pos != null) editor.view.dispatch(editor.state.tr.delete(pos, pos + cur.nodeSize))
      })
      const sep = () => Object.assign(document.createElement('span'), { className: 'ds-toolbar-sep' })
      bar.append(...sizeBtns, reset, sep(), ...alignBtns, sep(), big, del)

      // ── resize handle (inline-end bottom corner) ──
      const handle = document.createElement('span')
      handle.className = 'img-handle'
      handle.contentEditable = 'false'
      handle.title = t('Drag to resize')
      handle.onpointerdown = (e) => {
        if (!editor.isEditable) return
        e.preventDefault()
        e.stopPropagation()
        try {
          handle.setPointerCapture(e.pointerId) // keeps receiving moves outside the handle; not available for every pointer
        } catch {
          /* fine: the handle's own listeners still get the events while the pointer is over it */
        }
        const startX = e.clientX
        const startW = media.getBoundingClientRect().width
        const column = fig.closest<HTMLElement>('[data-type="layout-column"]')
        const container = column || editor.view.dom
        const padding = getComputedStyle(container)
        const col = column ? Math.max(1, container.clientWidth - (parseFloat(padding.paddingLeft) || 0) - (parseFloat(padding.paddingRight) || 0)) : container.getBoundingClientRect().width || 1
        const sign = getComputedStyle(fig).direction === 'rtl' ? -1 : 1 // the handle is on the inline-end side
        let pct = cur.attrs.width ?? 100
        const move = (ev: PointerEvent) => {
          pct = Math.min(100, Math.max(10, Math.round((((startW + (ev.clientX - startX) * sign) / col) * 100) / 5) * 5))
          fig.style.width = `${pct}%`
        }
        const up = () => {
          handle.removeEventListener('pointermove', move)
          handle.removeEventListener('pointerup', up)
          setAttrs({ width: pct })
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', up)
      }

      // the size / position / enlarge / remove toolbar is the floating ImageBubble now; `bar` stays only so its events keep being ignored
      fig.append(img, handle)

      const style = (n: typeof node) => {
        fig.style.width = n.attrs.width ? `${n.attrs.width}%` : ''
        fig.dataset.align = n.attrs.align ?? 'start'
        fig.classList.toggle('sized', !!n.attrs.width)
        sizeBtns.forEach((b, i) => b.classList.toggle('on', n.attrs.width === WIDTHS[i]))
        alignBtns.forEach((b, i) => b.classList.toggle('on', n.attrs.align === aligns[i][0]))
      }
      const load = (n: typeof node) => {
        img.alt = n.attrs.alt ?? ''
        if (n.attrs.src === current) return
        current = n.attrs.src
        Promise.all([urlFor(n.attrs.src), typeFor(n.attrs.src)]).then(([u, type]) => {
          if (current !== n.attrs.src) return
          if (!u) return void (img.alt = t('Image not found'))
          if (type && isVideo(type)) {
            showVideo(cur.attrs.motion === 'loop')
            video.src = u
          } else img.src = u
        })
      }
      img.ondblclick = () => img.src && openLightbox({ src: img.src, alt: cur.attrs.alt })
      style(node)
      load(node)

      return {
        dom: fig,
        update: (n) => {
          if (n.type.name !== 'image') return false
          cur = n
          style(n)
          load(n)
          return true
        },
        stopEvent: (e) => bar.contains(e.target as HTMLElement) || e.target === handle || (e.target === video && video.controls),
        ignoreMutation: () => true,
      }
    }
  },
})

const isMedia = (f: Blob) => f.type.startsWith('image/') || isVideo(f.type)

/** Pictures and videos from files. An animated GIF is stored as a short looping video when that is much smaller. */
export async function insertImages(editor: Editor, files: File[], pos?: number) {
  const imgs = files.filter(isMedia)
  for (const f of imgs) {
    const motion = isGif(f.type) ? await gifToVideo(f) : null
    const id = motion ? await putFile(motion, f.name.replace(/.gif$/i, '.mp4')) : await putFile(f)
    const node = { type: 'image', attrs: { src: `att:${id}`, alt: f.name, motion: motion ? 'loop' : null } }
    const chain = editor.chain().focus()
    ;(pos != null ? chain.insertContentAt(pos, node) : chain.insertContent(node)).run()
  }
  return imgs.length
}

export function pickImages(editor: Editor) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,video/*'
  input.multiple = true
  input.onchange = () => insertImages(editor, [...(input.files ?? [])])
  input.click()
}

/**
 * Image from an address. It is downloaded and stored like any other image, so the page keeps working offline;
 * if the site does not allow that (CORS), the link itself is used and the image then needs the internet.
 */
export async function insertImageFromUrl(editor: Editor, url?: string | null) {
  const u = (url ?? (await promptDialog({ title: t('Image from the web'), message: t('Image address (URL):'), placeholder: 'https://', ltr: true })) ?? '').trim()
  if (!u) return false
  let src = u
  let alt = decodeURIComponent(u.split('/').pop()?.split('?')[0] ?? '') || ''
  try {
    const blob = await (await fetch(u)).blob()
    if (!blob.type.startsWith('image/')) throw new Error('not an image')
    src = `att:${await putFile(blob, alt)}`
  } catch {
    /* keep the remote address */
  }
  editor.chain().focus().insertContent({ type: 'image', attrs: { src, alt } }).run()
  return true
}

/** Paste / drop of image files from outside the editor. */
export const ImageFiles = Extension.create({
  name: 'imageFiles',
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        props: {
          handlePaste: (_v, e) => {
            const files = [...(e.clipboardData?.files ?? [])].filter(isMedia)
            if (!files.length) return false
            insertImages(editor, files)
            return true
          },
          handleDrop: (view, e) => {
            const files = [...(e.dataTransfer?.files ?? [])].filter(isMedia)
            if (!files.length) return false
            const at = view.posAtCoords({ left: e.clientX, top: e.clientY })?.pos
            insertImages(editor, files, at)
            return true
          },
        },
      }),
    ]
  },
})
