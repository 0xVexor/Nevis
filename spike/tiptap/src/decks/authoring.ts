import type { AssetUpload, DocumentAsset } from '../documents/assets.ts'
import { ASSET_LIMIT, decodeDocumentAsset } from '../documents/assets.ts'
import type { EditNode, EditPlannerRuntime } from '../documents/editPlanner.ts'
import { prepareCreatedPage } from '../documents/mutations.ts'
import type { DocNode } from '../docNode.ts'

export type DeckSlideInput = { blocks: EditNode[]; assets?: AssetUpload[] }
export type DeckContentCheck = (content: DocNode) => string | null
export type CreateDeckInput = { operationId: string; parentId: string | null; title: string; slides: DeckSlideInput[] }
export type DeckChange =
  | ({ kind: 'insert_slide'; beforeSlideId: string | null } & DeckSlideInput)
  | ({ kind: 'replace_slide'; slideId: string } & DeckSlideInput)
  | { kind: 'move_slide'; slideId: string; beforeSlideId: string | null }
export type EditDeckInput = { documentId: string; expectedRevision: string; operationId: string; change: DeckChange }

export async function prepareDeckSlide(input: DeckSlideInput, id: string, operationId: string, runtime: EditPlannerRuntime, check: DeckContentCheck) {
  const checkImage = (node: EditNode) => {
    if (node.type === 'image' && (typeof node.attrs?.src !== 'string' || !/^(att|upload):/.test(node.attrs.src))) {
      throw { code: 'INVALID_ARGUMENT', field: 'markdown' }
    }
    node.content?.forEach(checkImage)
  }
  input.blocks.forEach(checkImage)
  const planned = await prepareCreatedPage({
    operationId,
    parentId: null,
    kind: 'page',
    metadata: { title: '', tags: [], favorite: false },
    content: { type: 'doc', content: input.blocks.length ? input.blocks : [{ type: 'paragraph' }] },
    ...(input.assets ? { assets: input.assets } : {}),
  }, id, 0, runtime)
  const content = planned.after.content
  if (check(content)) throw { code: 'UNSUPPORTED_CONTENT', field: 'markdown' }
  return { content, assets: planned.assets }
}

export function uniqueDeckAssets(assets: DocumentAsset[]) {
  const unique = [...new Map(assets.map((asset) => [asset.id, asset])).values()]
  if (unique.length > 20 || unique.reduce((size, asset) => size + decodeDocumentAsset(asset).length, 0) > ASSET_LIMIT) {
    throw { code: 'LIMIT_EXCEEDED', field: 'assets' }
  }
  return unique
}
