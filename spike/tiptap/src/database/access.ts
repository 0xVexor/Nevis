// Grants and property policy (handoff §22). The engine enforces them in queries, aggregates, relation pickers, formula context,
// exports and commands. Hiding a column in a view or filtering it is NOT a permission; these checks are.
import type { Definition, Grant, Id, Principal, Right } from './model/types.ts'
import { fail } from './model/errors.ts'
import type { DbState, Row } from './state.ts'

export type Cap = 'read' | 'comment' | 'create' | 'edit_rows' | 'edit_schema' | 'manage'

const RIGHT_CAPS: Record<Right, Cap[]> = {
  view: ['read'],
  comment: ['read', 'comment'],
  create: ['create'], // submit new rows and open only the pages individually granted; no browsing
  edit_content: ['read', 'comment', 'create', 'edit_rows'], // values and body, not the shared schema / views
  edit: ['read', 'comment', 'create', 'edit_rows', 'edit_schema'],
  full: ['read', 'comment', 'create', 'edit_rows', 'edit_schema', 'manage'],
}

export type PropertyRights = { seeDefinition: boolean; readValues: boolean; editValues: boolean; editDefinition: boolean }
const ALL: PropertyRights = { seeDefinition: true, readValues: true, editValues: true, editDefinition: true }
const NONE: PropertyRights = { seeDefinition: false, readValues: false, editValues: false, editDefinition: false }

export class Access {
  state: DbState
  constructor(state: DbState) {
    this.state = state
  }

  principal(id: Id): Principal | undefined {
    const p = this.state.get('principal', id)
    return p && p.deletedAt === null ? p : undefined
  }

  /** the principal itself plus every group that (transitively) contains it */
  closure(principalId: Id): Set<Id> {
    const out = new Set<Id>([principalId])
    const groups = this.state.live('principal').filter((p) => p.type === 'group')
    for (let changed = true; changed; ) {
      changed = false
      for (const g of groups) if (!out.has(g.id) && g.memberIds.some((m) => out.has(m))) (out.add(g.id), (changed = true))
    }
    return out
  }

  isOwner(principalId: Id): boolean {
    return !!this.principal(principalId)?.isLocalOwner
  }

  private grantsFor(principalId: Id): Grant[] {
    const ids = this.closure(principalId)
    return this.state.live('grant').filter((g) => ids.has(g.principalId))
  }

  /** Capabilities on a source (database-level grants only). */
  sourceCaps(principalId: Id, sourceId: Id): Set<Cap> {
    const caps = new Set<Cap>()
    if (this.isOwner(principalId)) return new Set(RIGHT_CAPS.full)
    const src = this.state.get('source', sourceId)
    if (!src) return caps
    for (const g of this.grantsFor(principalId)) {
      if (g.propertyId || g.viaPropertyId || g.pageId) continue
      if (g.sourceId === sourceId || (g.sourceId === null && g.containerId === src.ownerContainerId)) RIGHT_CAPS[g.right].forEach((c) => caps.add(c))
    }
    return caps
  }

  /** Capabilities on one row: database-level union page grants union row rules (widest wins; grants only ever add). */
  rowCaps(principalId: Id, row: Row): Set<Cap> {
    const caps = this.sourceCaps(principalId, row.sourceId)
    if (this.isOwner(principalId)) return caps
    for (const g of this.grantsFor(principalId)) {
      if (g.propertyId) continue
      if (g.pageId === row.page.id) RIGHT_CAPS[g.right].forEach((c) => caps.add(c))
      else if (g.viaPropertyId && g.sourceId === row.sourceId && this.memberOfProperty(row, g.viaPropertyId, principalId)) RIGHT_CAPS[g.right].forEach((c) => caps.add(c))
    }
    return caps
  }

  private memberOfProperty(row: Row, propertyId: Id, principalId: Id): boolean {
    const def = this.state.prop(propertyId)
    if (!def) return false
    const ids = this.closure(principalId)
    if (def.kind === 'created_by') return ids.has(row.page.recordMeta?.createdBy ?? '')
    if (def.kind === 'last_edited_by') return ids.has(row.page.recordMeta?.updatedBy ?? '')
    const cell = row.ext.cells[propertyId]?.value
    return cell?.kind === 'people' && cell.principalIds.some((p) => ids.has(p))
  }

  canSeeRow(principalId: Id, row: Row): boolean {
    return this.rowCaps(principalId, row).has('read')
  }

  /** Independent property rights (§22). Without a policy the database right decides; with one, only matching exceptions grant. */
  propertyRights(principalId: Id, def: Definition, row?: Row): PropertyRights {
    if (this.isOwner(principalId)) return ALL
    const caps = row ? this.rowCaps(principalId, row) : this.sourceCaps(principalId, def.sourceId)
    if (caps.has('manage')) return ALL // Full access bypasses a column restriction
    const policies = this.state.live('grant').filter((g) => g.propertyId === def.id && g.propertyRights)
    if (!policies.length) {
      return {
        seeDefinition: caps.has('read') || caps.has('create'),
        readValues: caps.has('read'),
        editValues: caps.has('edit_rows'),
        editDefinition: caps.has('edit_schema'),
      }
    }
    const ids = this.closure(principalId)
    let r = { ...NONE }
    for (const g of policies) {
      const matches = ids.has(g.principalId) || (g.viaPropertyId && row && this.memberOfProperty(row, g.viaPropertyId, principalId))
      if (!matches) continue
      const x = g.propertyRights!
      r = {
        seeDefinition: r.seeDefinition || x.seeDefinition || x.readValues || x.editValues,
        readValues: r.readValues || x.readValues || x.editValues,
        editValues: r.editValues || x.editValues,
        editDefinition: r.editDefinition || x.editDefinition,
      }
    }
    // page access must exist first
    if (row && !caps.has('read')) return NONE
    return r
  }

  canReadProperty(principalId: Id, def: Definition, row?: Row): boolean {
    if (def.kind === 'title') return row ? this.canSeeRow(principalId, row) : this.sourceCaps(principalId, def.sourceId).has('read')
    return this.propertyRights(principalId, def, row).readValues
  }

  canEditProperty(principalId: Id, def: Definition, row?: Row): boolean {
    return this.propertyRights(principalId, def, row).editValues
  }

  // ───── assertions used by commands ─────

  assertSource(principalId: Id, sourceId: Id, cap: Cap) {
    if (!this.sourceCaps(principalId, sourceId).has(cap)) fail('ACCESS_DENIED', `missing ${cap} access`, { sourceId })
  }
  assertRow(principalId: Id, row: Row, cap: Cap) {
    if (!this.rowCaps(principalId, row).has(cap)) fail('ACCESS_DENIED', `missing ${cap} access`, { pageId: row.page.id })
  }
  assertEditProperty(principalId: Id, def: Definition, row?: Row) {
    if (!this.canEditProperty(principalId, def, row)) fail('ACCESS_DENIED', 'you cannot edit this property', { propertyId: def.id })
  }
  assertReadProperty(principalId: Id, def: Definition) {
    if (!this.canReadProperty(principalId, def)) fail('ACCESS_DENIED', 'you cannot read this property', { propertyId: def.id })
  }
}
