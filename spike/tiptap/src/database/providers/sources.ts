// One-way imported sources (handoff §26): GitHub issues / PRs, GitLab issues / MRs, Jira and Asana. `pull` returns normalized items page by
// page with an opaque cursor; the caller (database command `external.apply`) keys them by (provider, externalSourceId, externalObjectId).
import type { ConnectedProvider, ImportItem, ProviderDeps, ProviderRecord } from './types.ts'
import { ProviderError } from './types.ts'
import { arr, nextLink, obj, request, str } from './http.ts'

const bad = (m: string) => new ProviderError('invalid_reference', m)
const none = async () => ({ results: [], nextCursor: null })
const noRetrieve = (id: ProviderRecord['provider']) => async () => { throw new ProviderError('invalid_reference', `${id} is an import source, not a connected property`) }

/** GitHub issues and pull requests of one repository. externalSourceId = "owner/repo". Scope: Issues: read (+ Pull requests: read). */
export function githubIssues(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://api.github.com'
  return {
    id: 'github_issues',
    capabilities: { search: false, refresh: false, sourceSync: true },
    validateReference(input) {
      const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(input.trim())
      if (!m) throw bad('use owner/repo')
      return { externalId: input.trim(), canonicalUrl: `https://github.com/${input.trim()}` }
    },
    search: none,
    retrieve: noRetrieve('github_issues'),
    async pull({ externalSourceId, cursor, since, signal }) {
      this.validateReference!(externalSourceId)
      const page = Number(cursor ?? 1) || 1
      const q = `state=all&per_page=100&page=${page}&sort=updated&direction=asc${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const r = await request(deps, `${base}/repos/${externalSourceId}/issues?${q}`, { signal, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } })
      const items: ImportItem[] = arr(r.json).map((x) => {
        const i = obj(x)
        return {
          externalObjectId: String(i.id), title: str(i.title), url: str(i.html_url), revision: str(i.updated_at),
          fields: { number: Number(i.number), kind: i.pull_request ? 'pull_request' : 'issue', state: str(i.state), author: str(obj(i.user).login), assignee: str(obj(i.assignee).login), labels: arr(i.labels).map((l) => str(obj(l).name)), createdAt: str(i.created_at), updatedAt: str(i.updated_at) },
        }
      })
      return { items, nextCursor: nextLink(r.headers) ? String(page + 1) : null }
    },
  }
}

/** GitLab issues and merge requests of one project. externalSourceId = "<project id or url-encoded path>:issues|merge_requests". Scope: read_api. */
export function gitlab(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://gitlab.com/api/v4'
  const parts = (id: string) => {
    const m = /^(.+):(issues|merge_requests)$/.exec(id.trim())
    if (!m || !m[1]) throw bad('use <project>:issues or <project>:merge_requests')
    return { project: m[1], kind: m[2] }
  }
  return {
    id: 'gitlab',
    capabilities: { search: false, refresh: false, sourceSync: true },
    validateReference(input) {
      const p = parts(input)
      return { externalId: input.trim(), canonicalUrl: `${base.replace(/\/api\/v4$/, '')}/${decodeURIComponent(p.project)}` }
    },
    search: none,
    retrieve: noRetrieve('gitlab'),
    async pull({ externalSourceId, cursor, since, signal }) {
      const { project, kind } = parts(externalSourceId)
      const page = Number(cursor ?? 1) || 1
      const q = `per_page=100&page=${page}&order_by=updated_at&sort=asc&state=all${since ? `&updated_after=${encodeURIComponent(since)}` : ''}`
      const r = await request(deps, `${base}/projects/${encodeURIComponent(decodeURIComponent(project))}/${kind}?${q}`, { signal })
      const items: ImportItem[] = arr(r.json).map((x) => {
        const i = obj(x)
        return { externalObjectId: String(i.id), title: str(i.title), url: str(i.web_url), revision: str(i.updated_at), fields: { iid: Number(i.iid), state: str(i.state), author: str(obj(i.author).username), assignee: str(obj(i.assignee).username), labels: arr(i.labels).map(str), createdAt: str(i.created_at), updatedAt: str(i.updated_at) } }
      })
      const next = r.headers.get('x-next-page')
      return { items, nextCursor: next ? next : null }
    },
  }
}

/** Jira Cloud project issues over the OAuth gateway. externalSourceId = "<cloudId>/<PROJECTKEY>". Scope: read:jira-work. */
export function jira(deps: ProviderDeps): ConnectedProvider {
  const parts = (id: string) => {
    const m = /^([A-Za-z0-9-]{8,64})\/([A-Z][A-Z0-9_]{1,31})$/.exec(id.trim())
    if (!m) throw bad('use <cloudId>/<PROJECTKEY>')
    return { cloud: m[1], key: m[2] }
  }
  return {
    id: 'jira',
    capabilities: { search: false, refresh: false, sourceSync: true },
    validateReference(input) {
      const p = parts(input)
      return { externalId: input.trim(), canonicalUrl: `https://api.atlassian.com/ex/jira/${p.cloud}/browse/${p.key}` }
    },
    search: none,
    retrieve: noRetrieve('jira'),
    async pull({ externalSourceId, cursor, since, signal }) {
      const { cloud, key } = parts(externalSourceId)
      const jql = `project = ${key}${since ? ` AND updated >= "${since.replace(/[^0-9T:\- ]/g, '').slice(0, 16).replace('T', ' ')}"` : ''} ORDER BY updated ASC`
      const base = deps.baseUrl ?? `https://api.atlassian.com/ex/jira/${cloud}`
      const r = await request(deps, `${base}/rest/api/3/search/jql`, { method: 'POST', signal, body: { jql, maxResults: 100, fields: ['summary', 'status', 'assignee', 'reporter', 'updated', 'created', 'labels'], ...(cursor ? { nextPageToken: cursor } : {}) } })
      const j = obj(r.json)
      const items: ImportItem[] = arr(j.issues).map((x) => {
        const i = obj(x)
        const f = obj(i.fields)
        return { externalObjectId: str(i.id), title: str(f.summary), url: `https://api.atlassian.com/ex/jira/${cloud}/browse/${str(i.key)}`, revision: str(f.updated), fields: { key: str(i.key), status: str(obj(f.status).name), assignee: str(obj(f.assignee).emailAddress) || str(obj(f.assignee).displayName), reporter: str(obj(f.reporter).displayName), labels: arr(f.labels).map(str), createdAt: str(f.created), updatedAt: str(f.updated) } }
      })
      return { items, nextCursor: str(j.nextPageToken) || null }
    },
  }
}

/** Asana tasks of one project. externalSourceId = project gid. Scope: default (read). */
export function asana(deps: ProviderDeps): ConnectedProvider {
  const base = deps.baseUrl ?? 'https://app.asana.com/api/1.0'
  return {
    id: 'asana',
    capabilities: { search: false, refresh: false, sourceSync: true },
    validateReference(input) {
      if (!/^\d{5,24}$/.test(input.trim())) throw bad('use the numeric project gid')
      return { externalId: input.trim(), canonicalUrl: `https://app.asana.com/0/${input.trim()}` }
    },
    search: none,
    retrieve: noRetrieve('asana'),
    async pull({ externalSourceId, cursor, since, signal }) {
      this.validateReference!(externalSourceId)
      const fields = 'name,completed,completed_at,assignee.name,assignee.email,due_on,modified_at,created_at,permalink_url'
      const r = await request(deps, `${base}/projects/${externalSourceId}/tasks?opt_fields=${encodeURIComponent(fields)}&limit=100${cursor ? `&offset=${encodeURIComponent(cursor)}` : ''}${since ? `&modified_since=${encodeURIComponent(since)}` : ''}`, { signal })
      const j = obj(r.json)
      const items: ImportItem[] = arr(j.data).map((x) => {
        const t = obj(x)
        return { externalObjectId: str(t.gid), title: str(t.name), url: str(t.permalink_url), revision: str(t.modified_at), fields: { completed: t.completed === true, assignee: str(obj(t.assignee).email) || str(obj(t.assignee).name), dueOn: str(t.due_on), createdAt: str(t.created_at), updatedAt: str(t.modified_at) } }
      })
      return { items, nextCursor: str(obj(j.next_page).offset) || null }
    },
  }
}

export const SOURCES: Record<string, (d: ProviderDeps) => ConnectedProvider> = { github_issues: githubIssues, gitlab, jira, asana }

/** Walk every page of a source (bounded). A source that cannot be read completely is reported as incomplete, never as "everything deleted". */
export async function pullAll(p: ConnectedProvider, externalSourceId: string, opts: { since?: string; maxPages?: number; signal?: AbortSignal } = {}): Promise<{ items: ImportItem[]; complete: boolean }> {
  if (!p.pull) throw new ProviderError('invalid_reference', 'this provider cannot be imported')
  const items: ImportItem[] = []
  let cursor: string | undefined
  for (let i = 0; i < (opts.maxPages ?? 50); i++) {
    const page = await p.pull({ externalSourceId, cursor, since: opts.since, signal: opts.signal })
    items.push(...page.items)
    if (!page.nextCursor) return { items, complete: opts.since === undefined } // a "since" pull is a delta, not the full list
    cursor = page.nextCursor
  }
  return { items, complete: false }
}
