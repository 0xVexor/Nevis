import { BLOCK_TYPES } from './blockIdentity.ts'
import type { Schema } from './contracts.ts'

// Persisted editor attributes, shared by MCP validation and its advertised schema.
// Block identities remain host-owned and are never accepted as author input.
type Rule = { types: readonly string[]; schema: Schema; valid(value: unknown): boolean }
const text = (max: number, empty = true): Omit<Rule, 'types'> => ({ schema: { type: 'string', minLength: empty ? 0 : 1, maxLength: max }, valid: value => typeof value === 'string' && [...value].length <= max && (empty || value.length > 0) })
const enumeration = (...values: string[]): Omit<Rule, 'types'> => ({ schema: { type: 'string', enum: values }, valid: value => values.includes(value as string) })
const number = (min: number, max: number, integer = false): Omit<Rule, 'types'> => ({ schema: { type: integer ? 'integer' : 'number', minimum: min, maximum: max }, valid: value => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) })
const nullable = (rule: Omit<Rule, 'types'>): Omit<Rule, 'types'> => ({ schema: { anyOf: [rule.schema, { type: 'null' }] }, valid: value => value === null || rule.valid(value) })
const boolean: Omit<Rule, 'types'> = { schema: { type: 'boolean' }, valid: value => typeof value === 'boolean' }
const rule = (types: string[], value: Omit<Rule, 'types'>): Rule => ({ types, ...value })
const list = (entry: Omit<Rule, 'types'>, max: number): Omit<Rule, 'types'> => ({ schema: { type: 'array', items: entry.schema, maxItems: max }, valid: value => Array.isArray(value) && value.length <= max && value.every(entry.valid) })
const fileId = { schema: { type: 'string', pattern: '^[a-f0-9]{64}$' }, valid: (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
const sceneId = { schema: { type: 'string', pattern: '^([a-f0-9]{64})?$' }, valid: (value: unknown) => value === '' || fileId.valid(value) }
export const EDITOR_BLOCKS = [...BLOCK_TYPES]
export const EDITOR_INLINES = ['text', 'hardBreak', 'pageLink', 'mathInline', 'inlineIcon']
export const EDITOR_MARKS = ['bold', 'italic', 'strike', 'underline', 'code', 'link']
export const EDITOR_ATTRIBUTES: Record<string, Rule> = {
  dir: rule(['paragraph', 'heading', 'blockquote', 'listItem', 'taskItem', 'table', 'tableCell', 'tableHeader'], enumeration('auto', 'ltr', 'rtl')),
  textAlign: rule(['paragraph', 'heading', 'codeBlock'], nullable(enumeration('left', 'center', 'right', 'justify'))),
  level: rule(['heading'], number(1, 6, true)),
  checked: rule(['taskItem'], boolean),
  language: rule(['codeBlock'], nullable(text(80))),
  start: rule(['orderedList'], number(1, Number.MAX_SAFE_INTEGER, true)),
  type: rule(['orderedList'], nullable(text(16))),
  emoji: rule(['callout'], text(64)), open: rule(['toggle'], boolean),
  latex: rule(['mathBlock', 'mathInline'], text(16000)), code: rule(['mermaid'], text(16000)),
  widths: rule(['layoutGroup'], nullable(list(number(20, 100), 3))),
  direction: rule(['layoutGroup'], nullable(enumeration('ltr', 'rtl'))),
  colspan: rule(['tableCell', 'tableHeader'], number(1, 100, true)),
  rowspan: rule(['tableCell', 'tableHeader'], number(1, 100, true)),
  colwidth: rule(['tableCell', 'tableHeader'], nullable(list(number(0, 100000, true), 100))),
  tableWidth: rule(['table'], nullable(number(1, 100))),
  tableAlign: rule(['table'], nullable(enumeration('left', 'center', 'right'))),
  align: rule(['image', 'tableCell', 'tableHeader'], nullable(enumeration('left', 'center', 'right', 'start', 'end', 'justify'))),
  width: rule(['image'], nullable(number(1, 100))),
  src: rule(['image'], text(200000, false)), alt: rule(['image'], nullable(text(4096))), title: rule(['image'], nullable(text(4096))),
  id: rule(['pageLink'], text(256, false)), label: rule(['pageLink'], nullable(text(512))),
  name: rule(['inlineIcon'], { schema: { type: 'string', pattern: '^[a-z0-9-]{1,80}$' }, valid: value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value) }),
  color: rule(['inlineIcon'], { schema: { anyOf: [{ type: 'string', pattern: '^#[a-fA-F0-9]{3,8}$' }, { type: 'null' }] }, valid: value => value === null || (typeof value === 'string' && /^#(?:[a-f0-9]{3}|[a-f0-9]{4}|[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value)) }),
  scene: rule(['drawing'], sceneId), preview: rule(['drawing'], sceneId),
  containerId: rule(['databaseEmbed'], text(256, false)),
}
export const editorAttributeSchema = Object.fromEntries(Object.entries(EDITOR_ATTRIBUTES).map(([key, value]) => [key, value.schema]))
export function editorAttributesValid(type: string, attrs: Record<string, unknown>) {
  return Object.entries(attrs).every(([key, value]) => EDITOR_ATTRIBUTES[key]?.types.includes(type) && EDITOR_ATTRIBUTES[key].valid(value))
}
export function safeLink(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && !/[\u0000-\u0020\u007f]/.test(value) && /^(https?:\/\/[^/]+|mailto:|tel:|#)/i.test(value)
}
export function safeImage(value: unknown): value is string {
  return typeof value === 'string' && (/^att:[a-f0-9]{64}$/.test(value) || (/^https?:\/\/[^/]+/i.test(value) && safeLink(value)) || /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value))
}
export function editorMarkValid(mark: { type: string; attrs?: Record<string, unknown> }) {
  if (!EDITOR_MARKS.includes(mark.type)) return false
  if (mark.type !== 'link') return !mark.attrs || Object.keys(mark.attrs).length === 0
  const attrs = mark.attrs
  return !!attrs && safeLink(attrs.href) && Object.keys(attrs).every(key => ['href', 'target', 'rel', 'class'].includes(key))
    && (attrs.target === undefined || attrs.target === null || ['_blank', '_self', '_parent', '_top'].includes(attrs.target as string))
    && ['rel', 'class'].every(key => attrs[key] === undefined || attrs[key] === null || (typeof attrs[key] === 'string' && /^[a-zA-Z0-9_ -]{0,256}$/.test(attrs[key] as string)))
    && (attrs.target !== '_blank' || attrs.rel === undefined || (typeof attrs.rel === 'string' && attrs.rel.split(/\s+/).includes('noopener')))
}

const contentModels: Record<string, string> = {
  doc: 'block+', paragraph: 'inline*', heading: 'inline*', blockquote: 'block+',
  bulletList: 'listItem+', orderedList: 'listItem+', listItem: 'paragraph block*',
  taskList: 'taskItem+', taskItem: 'paragraph block*', codeBlock: 'text*',
  table: 'tableRow+', tableRow: '(tableCell | tableHeader)+', tableCell: 'block+', tableHeader: 'block+',
  callout: 'block+', toggle: 'paragraph block*', layoutGroup: 'layoutColumn{2,3}', layoutColumn: 'block+',
}
const paragraphExample = { type: 'paragraph', content: [{ type: 'text', text: 'Example' }] }
export function editorCapabilities() {
  const examples: Record<string, unknown> = {
    doc: { type: 'doc', content: [paragraphExample] }, paragraph: paragraphExample,
    heading: { type: 'heading', attrs: { level: 2, dir: 'rtl' }, content: [{ type: 'text', text: 'عنوان' }] },
    blockquote: { type: 'blockquote', content: [paragraphExample] },
    bulletList: { type: 'bulletList', content: [{ type: 'listItem', content: [paragraphExample] }] },
    orderedList: { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [paragraphExample] }] },
    listItem: { type: 'listItem', content: [paragraphExample] },
    taskList: { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [paragraphExample] }] },
    taskItem: { type: 'taskItem', attrs: { checked: false }, content: [paragraphExample] },
    codeBlock: { type: 'codeBlock', attrs: { language: 'typescript' }, content: [{ type: 'text', text: 'const ready = true' }] },
    table: { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [paragraphExample] }, { type: 'tableCell', content: [paragraphExample] }] }] },
    tableRow: { type: 'tableRow', content: [{ type: 'tableCell', content: [paragraphExample] }] },
    tableCell: { type: 'tableCell', content: [paragraphExample] }, tableHeader: { type: 'tableHeader', content: [paragraphExample] },
    callout: { type: 'callout', attrs: { emoji: '💡' }, content: [paragraphExample] },
    toggle: { type: 'toggle', attrs: { open: false }, content: [paragraphExample, paragraphExample] },
    mathBlock: { type: 'mathBlock', attrs: { latex: '\\sum_{i=1}^n i' } }, mathInline: { type: 'mathInline', attrs: { latex: 'x^2' } },
    mermaid: { type: 'mermaid', attrs: { code: 'flowchart LR\n  Client --> Nevis' } },
    layoutGroup: { type: 'layoutGroup', attrs: { widths: [40, 60], direction: 'ltr' }, content: [{ type: 'layoutColumn', content: [paragraphExample] }, { type: 'layoutColumn', content: [paragraphExample] }] },
    layoutColumn: { type: 'layoutColumn', content: [paragraphExample] },
    image: { type: 'image', attrs: { src: 'https://example.org/image.png', alt: 'Image', width: 50, align: 'center' } },
    drawing: { type: 'drawing', attrs: { scene: '', preview: '' } },
    databaseEmbed: { type: 'databaseEmbed', attrs: { containerId: 'authorized-container-id' } },
    text: { type: 'text', text: 'Formatted text', marks: [{ type: 'bold' }] },
    pageLink: { type: 'pageLink', attrs: { id: 'authorized-page-id', label: 'Related note' } },
    inlineIcon: { type: 'inlineIcon', attrs: { name: 'star', color: '#6857f0' } },
  }
  return {
    profileVersion: 2,
    nodes: ['doc', ...EDITOR_BLOCKS, ...EDITOR_INLINES].map(type => ({ type,
      attributes: Object.fromEntries(Object.entries(EDITOR_ATTRIBUTES).filter(([, rule]) => rule.types.includes(type)).map(([key, rule]) => [key, rule.schema])),
      contentExpression: contentModels[type] ?? '', example: examples[type] ?? { type },
    })),
    marks: EDITOR_MARKS.map(type => ({ type, attributes: type === 'link' ? { href: { type: 'string' }, target: { type: 'string' }, rel: { type: 'string' }, class: { type: 'string' } } : {} })),
    notes: [
      'Use create_document or insert/replace_blocks with native node JSON. Block IDs are assigned by the host.',
      'layoutGroup is top-level only, has two or three columns, and explicit widths must each be at least 20 and total 100.',
      'Table rows must form a rectangular grid after colspan/rowspan expansion. Table rows/cells belong inside their table/row.',
      'Attachment hashes and database container IDs must already be referenced by a document in the current grant; a guessed ID is insufficient.',
      'Images accept att: references, HTTP(S) URLs or bounded PNG/JPEG/GIF/WebP data URLs. Links accept HTTP(S), mailto, tel or fragment URLs.',
      'Drawing scene/preview values reference stored attachments; an empty drawing can be edited in the Nevis canvas.',
    ],
  }
}
