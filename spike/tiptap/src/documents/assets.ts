import { isBlockId } from './blockIdentity.ts'

export type AssetDigest = (bytes: Uint8Array) => Promise<string>
export interface AssetUpload { temporaryId: string; mimeType: string; name: string; data: string }
export interface DocumentAsset { id: string; mimeType: string; name: string; data: string }
export const ASSET_LIMIT = 196608
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
export class DocumentAssetError extends Error {
  readonly code: 'INVALID_ARGUMENT' | 'CAPABILITY_UNAVAILABLE'
  constructor(code: 'INVALID_ARGUMENT' | 'CAPABILITY_UNAVAILABLE') { super(code === 'INVALID_ARGUMENT' ? 'Invalid document attachment' : 'Attachment storage unavailable'); this.code = code }
}
function invalid(): never { throw new DocumentAssetError('INVALID_ARGUMENT') }
export function decodeDocumentAsset(asset: Omit<DocumentAsset, 'id'>): Uint8Array {
  if (!asset || typeof asset !== 'object' || typeof asset.name !== 'string' || [...asset.name].length > 256 || typeof asset.data !== 'string'
    || asset.data.length > ASSET_LIMIT * 4 / 3 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(asset.data) || !asset.data) return invalid()
  const length = asset.data.length * 3 / 4 - (asset.data.endsWith('==') ? 2 : asset.data.endsWith('=') ? 1 : 0)
  const bytes = new Uint8Array(length)
  let output = 0
  for (let offset = 0; offset < asset.data.length; offset += 4) {
    const a = alphabet.indexOf(asset.data[offset]), b = alphabet.indexOf(asset.data[offset + 1]), c = alphabet.indexOf(asset.data[offset + 2]), d = alphabet.indexOf(asset.data[offset + 3])
    if (asset.data[offset + 2] === '=' && (b & 15) || asset.data[offset + 3] === '=' && c >= 0 && (c & 3)) return invalid()
    bytes[output++] = a << 2 | b >> 4
    if (output < length) bytes[output++] = (b & 15) << 4 | c >> 2
    if (output < length) bytes[output++] = (c & 3) << 6 | d
  }
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length))
  if (asset.mimeType === 'image/png' ? !starts([137, 80, 78, 71, 13, 10, 26, 10])
    : asset.mimeType === 'image/jpeg' ? !starts([255, 216, 255])
    : asset.mimeType === 'image/gif' ? !['GIF87a', 'GIF89a'].includes(ascii(0, 6))
    : asset.mimeType === 'image/webp' ? ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WEBP'
    : asset.mimeType !== 'application/vnd.excalidraw+json') return invalid()
  if (asset.mimeType === 'application/vnd.excalidraw+json') {
    try {
      const json = JSON.parse(decodeURIComponent(Array.from(bytes, byte => `%${byte.toString(16).padStart(2, '0')}`).join('')))
      if (!json || json.type !== 'excalidraw' || !Array.isArray(json.elements)) return invalid()
      let count = 0
      const inspect = (value: unknown, depth: number) => {
        if (++count > 20000 || depth > 32) return invalid()
        if (value && typeof value === 'object') Object.values(value).forEach(child => inspect(child, depth + 1))
      }
      inspect(json, 0)
    } catch { return invalid() }
  }
  return bytes
}
export async function prepareDocumentAssets(uploads: AssetUpload[], digest?: AssetDigest) {
  if (!digest) throw new DocumentAssetError('CAPABILITY_UNAVAILABLE')
  if (!Array.isArray(uploads) || !uploads.length || uploads.length > 20) return invalid()
  const names = new Set<string>(), ids = new Map<string, string>(), assets = new Map<string, DocumentAsset>()
  let size = 0
  for (const upload of uploads) {
    if (!upload || Object.keys(upload).sort().join(',') !== 'data,mimeType,name,temporaryId' || !isBlockId(upload.temporaryId) || names.has(upload.temporaryId)) return invalid()
    names.add(upload.temporaryId)
    const bytes = decodeDocumentAsset(upload)
    if ((size += bytes.length) > ASSET_LIMIT) return invalid()
    const id = await digest(bytes)
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid attachment digest')
    ids.set(upload.temporaryId, id)
    if (!assets.has(id)) assets.set(id, { id, mimeType: upload.mimeType, name: upload.name, data: upload.data })
  }
  return { ids, assets: [...assets.values()] }
}
export async function verifyDocumentAssets(assets: DocumentAsset[], digest?: AssetDigest) {
  const prepared = await prepareDocumentAssets(assets.map(asset => ({ temporaryId: asset.id, mimeType: asset.mimeType, name: asset.name, data: asset.data })), digest)
  for (const asset of assets) if (prepared.ids.get(asset.id) !== asset.id) return invalid()
  return assets.map(asset => ({ ...asset, bytes: decodeDocumentAsset(asset) }))
}
