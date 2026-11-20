// The schema contract (ADR-0003 §5): every attribute has a non-null default and is a string, integer or boolean.
// `dir` is "auto" | "rtl" | "ltr"; `blockId` is a UUIDv7 string ("" until the identity plugin assigns one).
import { Extension, type AnyExtension } from '@tiptap/core'
import CodeBlock from '@tiptap/extension-code-block'
import Link from '@tiptap/extension-link'
import { BulletList, OrderedList, ListItem, TaskList, TaskItem } from '@tiptap/extension-list'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import StarterKit from '@tiptap/starter-kit'

/** Nodes that carry a stable `blockId`. */
export const BLOCK_TYPES = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'taskList', 'taskItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableHeader', 'tableCell'] as const
/** Nodes that carry a text direction. */
export const DIR_TYPES = ['paragraph', 'heading', 'table'] as const
export const SV = 1

const Attrs = Extension.create({
  name: 'nevisAttrs',
  addGlobalAttributes() {
    return [
      {
        types: [...DIR_TYPES],
        attributes: {
          dir: {
            default: 'auto',
            parseHTML: (el: HTMLElement) => (['rtl', 'ltr'].includes(el.getAttribute('dir') ?? '') ? el.getAttribute('dir') : 'auto'),
            // `auto` is the default and is not written, so that dir=auto never fights the browser's own bidi
            renderHTML: (attrs: Record<string, unknown>) => (attrs.dir === 'rtl' || attrs.dir === 'ltr' ? { dir: attrs.dir as string } : {}),
          },
        },
      },
      {
        types: [...BLOCK_TYPES],
        attributes: {
          blockId: {
            default: '',
            parseHTML: () => '', // pasted or imported HTML never brings an id: the identity plugin assigns a fresh one
            renderHTML: (attrs: Record<string, unknown>) => (attrs.blockId ? { 'data-block-id': attrs.blockId as string } : {}),
          },
        },
      },
      { types: ['taskItem'], attributes: { due: { default: '' } } },
    ]
  },
})

// prosemirror-tables defaults `colwidth` to null; column widths are out of scope for the schema's first version.
const Cell = TableCell.extend({ addAttributes: () => ({ colspan: { default: 1 }, rowspan: { default: 1 } }) })
const Header = TableHeader.extend({ addAttributes: () => ({ colspan: { default: 1 }, rowspan: { default: 1 } }) })

export const schemaExtensions: AnyExtension[] = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3] },
    // not part of the schema contract, or behaviour that belongs to the editor (history comes from Yjs)
    undoRedo: false, strike: false, underline: false, horizontalRule: false, dropcursor: false, gapcursor: false, trailingNode: false, listKeymap: false,
    bulletList: false, orderedList: false, listItem: false, link: false,
    codeBlock: false,
  }),
  // list nodes and code blocks, redefined so that no attribute defaults to null
  BulletList,
  OrderedList.extend({ addAttributes: () => ({ start: { default: 1 } }) }),
  ListItem,
  TaskList,
  TaskItem.configure({ nested: true }),
  CodeBlock.extend({ addAttributes: () => ({ language: { default: '' } }) }),
  Link.extend({ addAttributes: () => ({ href: { default: '' }, target: { default: '' }, rel: { default: '' }, class: { default: '' } }) }).configure({ openOnClick: false, autolink: false }),
  Table.configure({ resizable: false }),
  TableRow,
  Header,
  Cell,
  Attrs,
]
