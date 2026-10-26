// Connected-property providers: one external object per reference (Google Drive file, Figma file, Zendesk ticket, GitHub pull request).
// Each validates the reference strictly (host + shape), asks for the least scope that can read metadata, and returns only typed fields.
import type { ConnectedProvider, ProviderDeps, ProviderRecord } from './types.ts'
import { ProviderError } from './types.ts'
import { arr, at, obj, request, str } from './http.ts'

const bad = (m: string) => new ProviderError('invalid_reference', m)
function parse(input: string): URL {
  try {
    return new URL(input.trim())
  } catch {
    throw bad('this is not a link')
  }
}
const rec = (provider: ProviderRecord['provider'], externalId: string, canonicalUrl: string, fields: ProviderRecord['fields'], providerRevision: string, deps: ProviderDeps): ProviderRecord => ({ provider, externalId, canonicalUrl, fields, providerRevision, fetchedAt: at(deps) })

/** Google Drive. Minimum scope: https://www.googleapis.com/auth/drive.metadata.readonly (or drive.file for files the app opened). */
export function googleDrive(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://www.googleapis.com/drive/v3'
  const FIELDS = 'id,name,mimeType,modifiedTime,version,webViewLink,iconLink,trashed'
  return {
    id: 'gdrive',
    capabilities: { search: true, refresh: true, sourceSync: false },
    validateReference(input) {
      const u = parse(input)
      if (u.protocol !== 'https:' || !['drive.google.com', 'docs.google.com'].includes(u.hostname)) throw bad('only drive.google.com and docs.google.com links are supported')
      const m = /\/(?:file|document|spreadsheets|presentation|forms)\/d\/([A-Za-z0-9_-]{10,})/.exec(u.pathname) ?? (u.pathname === '/open' ? [null, u.searchParams.get('id') ?? ''] : null)
      const id = m?.[1] ?? ''
      if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) throw bad('no file id in this link')
      return { externalId: id, canonicalUrl: `https://drive.google.com/file/d/${id}/view` }
    },
    async search({ query, cursor, signal }) {
      const q = `name contains '${query.replace(/['\\]/g, ' ')}' and trashed = false`
      const r = await request(deps, `${base}/files?q=${encodeURIComponent(q)}&pageSize=25&fields=${encodeURIComponent('nextPageToken,files(id,name,webViewLink)')}&supportsAllDrives=true&includeItemsFromAllDrives=true${cursor ? `&pageToken=${encodeURIComponent(cursor)}` : ''}`, { signal })
      const j = obj(r.json)
      return { results: arr(j.files).map((f) => ({ externalId: str(obj(f).id), title: str(obj(f).name), url: str(obj(f).webViewLink) })), nextCursor: str(j.nextPageToken) || null }
    },
    async retrieve({ externalId, signal }) {
      const r = await request(deps, `${base}/files/${encodeURIComponent(externalId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=true`, { signal })
      const j = obj(r.json)
      if (!j.id) throw new ProviderError('bad_response', 'no file in the answer')
      return rec('gdrive', externalId, str(j.webViewLink) || `https://drive.google.com/file/d/${externalId}/view`, { name: str(j.name), mimeType: str(j.mimeType), modifiedTime: str(j.modifiedTime), trashed: j.trashed === true }, str(j.version) || str(j.modifiedTime), deps)
    },
  }
}

/** Figma. Minimum scope: file_content:read (OAuth) or a read-only personal access token. */
export function figma(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://api.figma.com/v1'
  return {
    id: 'figma',
    capabilities: { search: false, refresh: true, sourceSync: false },
    validateReference(input) {
      const u = parse(input)
      if (u.protocol !== 'https:' || !/^(www\.)?figma\.com$/.test(u.hostname)) throw bad('only figma.com links are supported')
      const m = /^\/(?:file|design|proto|board|slides)\/([A-Za-z0-9]{10,})/.exec(u.pathname)
      if (!m) throw bad('no Figma file key in this link')
      return { externalId: m[1], canonicalUrl: `https://www.figma.com/file/${m[1]}` }
    },
    async search() {
      return { results: [], nextCursor: null } // Figma has no file search API for a single token
    },
    async retrieve({ externalId, signal }) {
      const r = await request(deps, `${base}/files/${encodeURIComponent(externalId)}?depth=1`, { signal })
      const j = obj(r.json)
      if (!j.name) throw new ProviderError('bad_response', 'no file in the answer')
      return rec('figma', externalId, `https://www.figma.com/file/${externalId}`, { name: str(j.name), lastModified: str(j.lastModified), editorType: str(j.editorType), thumbnailUrl: str(j.thumbnailUrl) }, str(j.version) || str(j.lastModified), deps)
    },
  }
}

/** Zendesk Support ticket. Minimum scope: tickets:read. The subdomain comes from the link and is the only host ever called. */
export function zendesk(deps: ProviderDeps): ConnectedProvider {
  const origin = (sub: string) => deps.baseUrl ?? `https://${sub}.zendesk.com`
  return {
    id: 'zendesk',
    capabilities: { search: false, refresh: true, sourceSync: false },
    validateReference(input) {
      const u = parse(input)
      const sub = /^([a-z0-9][a-z0-9-]{0,62})\.zendesk\.com$/.exec(u.hostname)?.[1]
      if (u.protocol !== 'https:' || !sub) throw bad('only https://<subdomain>.zendesk.com links are supported')
      const m = /\/(?:agent\/tickets|tickets|requests)\/(\d{1,12})/.exec(u.pathname)
      if (!m) throw bad('no ticket number in this link')
      return { externalId: `${sub}:${m[1]}`, canonicalUrl: `https://${sub}.zendesk.com/agent/tickets/${m[1]}` }
    },
    async search() {
      return { results: [], nextCursor: null } // searching tickets needs an agent-scoped token; paste a ticket link instead
    },
    async retrieve({ externalId, signal }) {
      const [sub, id] = externalId.split(':')
      if (!sub || !/^\d+$/.test(id ?? '')) throw bad('malformed Zendesk id')
      const r = await request(deps, `${origin(sub)}/api/v2/tickets/${id}.json`, { signal })
      const t = obj(obj(r.json).ticket)
      if (!t.id) throw new ProviderError('bad_response', 'no ticket in the answer')
      return rec('zendesk', externalId, `https://${sub}.zendesk.com/agent/tickets/${id}`, { subject: str(t.subject), status: str(t.status), priority: str(t.priority), updatedAt: str(t.updated_at) }, str(t.updated_at), deps)
    },
  }
}

/** GitHub pull request. Minimum scope: a fine-grained token with Pull requests: read on that repository (or `repo` for classic tokens). */
export function githubPullRequest(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://api.github.com'
  const H = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' }
  return {
    id: 'github_pr',
    capabilities: { search: true, refresh: true, sourceSync: false },
    validateReference(input) {
      const u = parse(input)
      if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw bad('only github.com links are supported')
      const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,9})/.exec(u.pathname)
      if (!m) throw bad('this is not a pull request link')
      return { externalId: `${m[1]}/${m[2]}#${m[3]}`, canonicalUrl: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` }
    },
    async search({ query, cursor, signal }) {
      const page = Number(cursor ?? 1) || 1
      const r = await request(deps, `${base}/search/issues?q=${encodeURIComponent(`${query} is:pr`)}&per_page=25&page=${page}`, { signal, headers: H })
      const j = obj(r.json)
      const items = arr(j.items)
      return { results: items.map((i) => ({ externalId: str(obj(i).repository_url).replace(/^.*\/repos\//, '') + '#' + String(obj(i).number), title: str(obj(i).title), url: str(obj(i).html_url) })), nextCursor: items.length === 25 ? String(page + 1) : null }
    },
    async retrieve({ externalId, signal }) {
      const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(externalId)
      if (!m) throw bad('malformed pull request id')
      const r = await request(deps, `${base}/repos/${m[1]}/${m[2]}/pulls/${m[3]}`, { signal, headers: H })
      const j = obj(r.json)
      if (!j.number) throw new ProviderError('bad_response', 'no pull request in the answer')
      return rec('github_pr', externalId, str(j.html_url), { title: str(j.title), state: j.merged === true ? 'merged' : str(j.state), draft: j.draft === true, author: str(obj(j.user).login), updatedAt: str(j.updated_at) }, str(obj(j.head).sha) || str(j.updated_at), deps)
    },
  }
}

export const CONNECTED: Record<string, (d: ProviderDeps) => ConnectedProvider> = { gdrive: googleDrive, figma, zendesk, github_pr: githubPullRequest }

/** Pick the provider whose validator accepts a pasted link. */
export function detectProvider(input: string, deps: ProviderDeps): ConnectedProvider | null {
  for (const make of Object.values(CONNECTED)) {
    const p = make(deps)
    try { p.validateReference(input); return p } catch { /* try the next */ }
  }
  return null
}
