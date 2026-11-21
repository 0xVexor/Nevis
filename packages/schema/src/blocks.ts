// The block and inline nodes ported from the old editor (M8a), as SCHEMA ONLY: no DOM, no node views (ADR-0003 §9; the schema loads
// in plain Node). Their behaviour (node views, commands, KaTeX/Mermaid/Excalidraw rendering) lives in `@nevis/editor`.
//
// Every attribute is a string, an integer or a boolean with a non-null default (ADR-0003 §5; `auditSchema` checks it). What changed
// from the old editor, and why:
//  - callout `emoji` -> `icon` (the old value was an emoji or an icon name; the name is what is kept);
//  - layout `widths` (a JSON array on the group) -> an integer `width` on each column (0 = an equal share), so concurrent edits of two
//    columns merge; `direction` (null | rtl | ltr) -> the standard `dir` of the group;
//  - drawing `scene` is a JSON STRING (<= 256 KB, enforced where it is written) and the old `preview` (a data URL) is dropped: the
//    preview is drawn from the scene on screen;
//  - image `src` is only ever empty (a placeholder) or an https URL until attachments exist (M9); `width` 0 = natural, `align`
//    '' | start | center | end (logical), `motion` '' | loop;
//  - page link `id` -> `dstId`, `label` null -> '' (a cache of the target's title);
//  - `textAlign`, `tableAlign` null -> '', `tableWidth` null -> 0.
import { Node, mergeAttributes } from '@tiptap/core'

const str = (name: string, attr = name) => ({ default: '', parseHTML: (el: HTMLElement) => el.getAttribute(`data-${attr}`) ?? '', renderHTML: (a: Record<string, unknown>) => (a[name] ? { [`data-${attr}`]: String(a[name]) } : {}) })
const int = (name: string, attr = name) => ({ default: 0, parseHTML: (el: HTMLElement) => Math.max(0, Math.trunc(Number(el.getAttribute(`data-${attr}`)) || 0)), renderHTML: (a: Record<string, unknown>) => (a[name] ? { [`data-${attr}`]: String(a[name]) } : {}) })

/** A scene may not exceed this many characters (ROADMAP M8a; the editor refuses to write a bigger one). */
export const MAX_DRAWING_SCENE = 256 * 1024
/** A formula or a diagram source may not exceed this many characters. */
export const MAX_SOURCE = 64 * 1024

export const Callout = Node.create({
  name: 'callout', group: 'block', content: 'block+', defining: true,
  addAttributes: () => ({ icon: { default: 'bulb', parseHTML: (el: HTMLElement) => el.getAttribute('data-icon') || 'bulb', renderHTML: (a: Record<string, unknown>) => ({ 'data-icon': String(a.icon) }) } }),
  parseHTML: () => [{ tag: 'div[data-type="callout"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'callout' }, HTMLAttributes), 0],
})

/** The first paragraph is the always-visible title, the rest is hidden while the toggle is closed. */
export const Toggle = Node.create({
  name: 'toggle', group: 'block', content: 'paragraph block*', defining: true,
  addAttributes: () => ({ open: { default: true, parseHTML: (el: HTMLElement) => el.getAttribute('data-open') !== 'false', renderHTML: (a: Record<string, unknown>) => ({ 'data-open': String(a.open) }) } }),
  parseHTML: () => [{ tag: 'div[data-type="toggle"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'toggle' }, HTMLAttributes), 0],
})

export const LayoutGroup = Node.create({
  name: 'layoutGroup', group: 'block', content: 'layoutColumn{2,3}', defining: true, isolating: true,
  parseHTML: () => [{ tag: 'div[data-type="layout-group"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'layout-group', class: 'layout-group' }, HTMLAttributes), 0],
})
export const LayoutColumn = Node.create({
  name: 'layoutColumn', content: 'block+', defining: true, isolating: true,
  addAttributes: () => ({ width: int('width') }),
  parseHTML: () => [{ tag: 'div[data-type="layout-column"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'layout-column', class: 'layout-column' }, HTMLAttributes), 0],
})

export const MathBlock = Node.create({
  name: 'mathBlock', group: 'block', atom: true, selectable: true,
  addAttributes: () => ({ latex: str('latex') }),
  parseHTML: () => [{ tag: 'div[data-type="math-block"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'math-block' }, HTMLAttributes), String(node.attrs.latex)],
  renderText: ({ node }) => String(node.attrs.latex),
})
export const MathInline = Node.create({
  name: 'mathInline', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes: () => ({ latex: str('latex') }),
  parseHTML: () => [{ tag: 'span[data-type="math-inline"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes({ 'data-type': 'math-inline' }, HTMLAttributes), String(node.attrs.latex)],
  renderText: ({ node }) => String(node.attrs.latex),
})

export const Mermaid = Node.create({
  name: 'mermaid', group: 'block', atom: true, selectable: true,
  addAttributes: () => ({ code: str('code') }),
  parseHTML: () => [{ tag: 'div[data-type="mermaid"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'mermaid' }, HTMLAttributes), String(node.attrs.code)],
  renderText: ({ node }) => String(node.attrs.code),
})

export const Drawing = Node.create({
  name: 'drawing', group: 'block', atom: true, selectable: true,
  addAttributes: () => ({ scene: str('scene') }),
  parseHTML: () => [{ tag: 'div[data-type="drawing"]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-type': 'drawing' }, HTMLAttributes)],
})

/** `src` is '' (a placeholder) or an https URL until M9 brings attachments; the editor never puts a `data:` URL here. */
export const Image = Node.create({
  name: 'image', group: 'block', atom: true, selectable: true, draggable: true,
  addAttributes: () => ({ src: str('src'), alt: str('alt'), title: str('title'), width: int('width', 'w'), align: str('align'), motion: str('motion') }),
  parseHTML: () => [{ tag: 'figure[data-type="image"]' }, { tag: 'img[src]', getAttrs: el => ({ src: (el as HTMLElement).getAttribute('src') ?? '', alt: (el as HTMLElement).getAttribute('alt') ?? '', title: (el as HTMLElement).getAttribute('title') ?? '' }) }],
  renderHTML: ({ node, HTMLAttributes }) => ['figure', mergeAttributes({ 'data-type': 'image' }, HTMLAttributes), ['img', { src: String(node.attrs.src), alt: String(node.attrs.alt) }]],
  renderText: ({ node }) => String(node.attrs.alt),
})

/** A link to another page. `dstId` is the target's id (what is stable); `label` is a cache of its title for showing and for text. */
export const PageLink = Node.create({
  name: 'pageLink', group: 'inline', inline: true, atom: true, selectable: true,
  addAttributes: () => ({ dstId: str('dst'), label: str('label') }),
  parseHTML: () => [{ tag: 'span[data-type="page-link"]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes({ 'data-type': 'page-link' }, HTMLAttributes), String(node.attrs.label)],
  renderText: ({ node }) => String(node.attrs.label),
})

export const blockNodes = [Callout, Toggle, LayoutGroup, LayoutColumn, MathBlock, MathInline, Mermaid, Drawing, Image, PageLink]
