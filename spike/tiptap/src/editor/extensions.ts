import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { CodeBlock } from './codeBlock'
import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Placeholder } from '@tiptap/extensions'
import { SlashCommand } from './slash'
import { CommandPalette } from './commandPalette'
import { FindInPage } from './find'
import { MermaidBlock } from './mermaid'
import { DrawingBlock } from './drawing'
import { DatabaseEmbed } from './databaseEmbed'
import { AttImage, ImageFiles } from './image'
import { InlineIcon } from './inlineIcon'
import { HeadingDir } from './headingDir'
import { FlowArrows } from './flowArrows'
import { DragHandle } from './dragHandle'
import { LayoutGroup, LayoutColumn, LayoutSafety } from './layout'
import { MarkdownPaste } from './markdownPaste'
import { MarkdownTab } from './markdownTab'
import { MathAuto, MathBlock, MathInline } from './math'
import { Callout, Toggle } from './blocks'
import { PageLink, PageLinkSuggest } from './pageLink'
import { t } from '../i18n'
import { createSectionDragSurface } from './snapSurface'
import { BlockIdentity } from './blockIdentity'

const BaseTableView = (Table as any).options.View

// The default table NodeView ignores node attrs, so mirror `dir` onto <table>.
function DirTableView(this: any, node: any, ...rest: any[]) {
  const view = new BaseTableView(node, ...rest)
  const surface = createSectionDragSurface(t('Move table'), t('Drag this area to move the whole block.'))
  view.dom.prepend(surface)
  const apply = (n: any) => {
    view.table.setAttribute('dir', n.attrs.dir || 'auto')
    // width and position belong to the wrapper <div class="tableWrapper"> around the table
    const wrap = view.dom as HTMLElement
    wrap.style.width = n.attrs.tableWidth ? `${n.attrs.tableWidth}%` : ''
    if (n.attrs.tableAlign) wrap.dataset.align = n.attrs.tableAlign
    else delete wrap.dataset.align
  }
  apply(node)
  const update = view.update.bind(view)
  view.update = (n: any) => {
    const ok = update(n)
    if (ok) apply(n)
    return ok
  }
  return view
}

const LEAF = ['paragraph', 'heading']
const CONTAINER = ['blockquote', 'tableCell', 'tableHeader', 'table', 'listItem', 'taskItem']

// Automatic block directions are rendered by HeadingDir. Persisted `dir` attributes
// remain manual overrides; container dir=auto also works in exported HTML.
const Direction = Extension.create({
  name: 'direction',
  addGlobalAttributes() {
    const parseHTML = (el: HTMLElement) => el.getAttribute('dir') || 'auto'
    return [
      // Leaf blocks omit dir=auto: a dir=auto <p> would hide its text from the parent <li>/<td> detection.
      {
        types: LEAF,
        attributes: {
          dir: {
            default: 'auto',
            parseHTML,
            renderHTML: (a: any) => (a.dir && a.dir !== 'auto' ? { dir: a.dir } : {}),
          },
        },
      },
      // Text alignment by physical side (left / center / right / justify), like Word; null = natural (follows the direction).
      {
        types: LEAF,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => el.style.textAlign || null,
            renderHTML: (a: any) => (a.textAlign ? { style: `text-align: ${a.textAlign}` } : {}),
          },
        },
      },
      // Containers always render dir so markers, borders and column order follow it.
      {
        types: CONTAINER,
        attributes: {
          dir: { default: 'auto', parseHTML, renderHTML: (a: any) => ({ dir: a.dir || 'auto' }) },
        },
      },
      // Tables can be narrower than the column and placed left / center / right (physical sides, like Word).
      {
        types: ['table'],
        attributes: {
          tableAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-table-align'),
            renderHTML: (a: any) => (a.tableAlign ? { 'data-table-align': a.tableAlign } : {}),
          },
          tableWidth: {
            default: null,
            parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-table-width')) || null,
            renderHTML: (a: any) => (a.tableWidth ? { 'data-table-width': a.tableWidth } : {}),
          },
        },
      },
    ]
  },
  addCommands() {
    const setDirection = (dir: string) => ({ state, tr, dispatch }: any) => {
      const { from, to } = state.selection
      state.doc.nodesBetween(from, to, (node: any, pos: number) => {
        if ([...LEAF, ...CONTAINER].includes(node.type.name) && node.type.name !== 'table') {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, dir })
        }
      })
      if (dispatch) dispatch(tr)
      return true
    }
    const setTableDirection = (dir: string) => ({ state, tr, dispatch }: any) => {
      const { $from } = state.selection
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
          tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, dir })
          if (dispatch) dispatch(tr)
          return true
        }
      }
      return false
    }
    // patch the table the caret (or a cell selection) is in
    const patchTable = (patch: (attrs: any) => any) => ({ state, tr, dispatch }: any) => {
      const { $from } = state.selection
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === 'table') {
          tr.setNodeMarkup($from.before(d), undefined, { ...$from.node(d).attrs, ...patch($from.node(d).attrs) })
          if (dispatch) dispatch(tr)
          return true
        }
      }
      return false
    }
    const setTableWidth = (w: number | null) => patchTable(() => ({ tableWidth: w && w < 100 ? w : null }))
    // a full-width table has nowhere to move to, so choosing a side also narrows it to 75 %
    const setTableAlign = (a: 'left' | 'center' | 'right' | null) =>
      patchTable((attrs) => ({ tableAlign: a, ...(a && !attrs.tableWidth ? { tableWidth: 75 } : {}) }))
    // paragraphs and headings in the selection; choosing the side that is already set clears it
    const setTextAlign = (a: 'left' | 'center' | 'right' | 'justify') => ({ state, tr, dispatch }: any) => {
      const { from, to } = state.selection
      const nodes: [any, number][] = []
      state.doc.nodesBetween(from, to, (node: any, pos: number) => void (([...LEAF, 'codeBlock'].includes(node.type.name)) && nodes.push([node, pos])))
      const clear = nodes.length > 0 && nodes.every(([n]) => n.attrs.textAlign === a)
      for (const [node, pos] of nodes) tr.setNodeMarkup(pos, undefined, { ...node.attrs, textAlign: clear ? null : a })
      if (dispatch) dispatch(tr)
      return nodes.length > 0
    }
    return { setDirection, setTableDirection, setTableWidth, setTableAlign, setTextAlign } as any
  },
  // Word's shortcut: left Ctrl + left Shift = LTR, right Ctrl + right Shift = RTL. It fires when the two keys are
  // released without any other key in between, so Ctrl+Shift+Z etc. are not mistaken for it.
  addProseMirrorPlugins() {
    const editor = this.editor as any
    let ctrl: 'L' | 'R' | null = null
    let shift: 'L' | 'R' | null = null
    let armed = false
    const side = (code: string) => (code.endsWith('Left') ? 'L' : 'R')
    const reset = () => ((ctrl = shift = null), (armed = false))
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            blur: () => (reset(), false),
            keydown: (_v, e: KeyboardEvent) => {
              if (e.code === 'ControlLeft' || e.code === 'ControlRight') ctrl = side(e.code)
              else if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') shift = side(e.code)
              else {
                armed = false // some other key was pressed: this is a different shortcut
                return false
              }
              if (ctrl && shift && ctrl === shift) armed = true // both held, same side
              return false
            },
            keyup: (_v, e: KeyboardEvent) => {
              const mod = /^(Control|Shift)(Left|Right)$/.test(e.code)
              if (mod && armed) {
                armed = false
                editor.commands.setDirection(ctrl === 'L' ? 'ltr' : 'rtl')
              }
              if (e.code.startsWith('Control')) ctrl = null
              if (e.code.startsWith('Shift')) shift = null
              if (!ctrl && !shift) armed = false
              return false
            },
          },
        },
      }),
    ]
  },
  addKeyboardShortcuts() {
    const ed = this.editor as any
    return {
      'Mod-Shift-ArrowRight': () => ed.commands.setDirection('ltr'),
      'Mod-Shift-ArrowLeft': () => ed.commands.setDirection('rtl'),
    }
  },
})

export const extensions = [
  BlockIdentity,
  StarterKit.configure({ codeBlock: false }),
  CodeBlock,
  Table.configure({ resizable: true, View: DirTableView as any }),
  TableRow,
  TableHeader,
  TableCell,
  TaskList,
  TaskItem.configure({ nested: true }),
  AttImage,
  InlineIcon,
  HeadingDir,
  FlowArrows,
  MathAuto,
  ImageFiles,
  MarkdownPaste,
  MarkdownTab,
  Callout,
  Toggle,
  MathInline,
  MathBlock,
  PageLink,
  PageLinkSuggest,
  LayoutGroup,
  LayoutColumn,
  LayoutSafety,
  DragHandle,
  FindInPage,
  MermaidBlock,
  DrawingBlock,
  DatabaseEmbed,
  Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'paragraph' ? t('Start writing, or press / for commands…') : ''), showOnlyCurrent: true }),
  Direction,
  SlashCommand,
  CommandPalette,
]
