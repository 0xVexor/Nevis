// The contract between the database container (header, tabs, shared controls) and the view renderers.
import type { Cell, Container, Id, Json, View } from '../model/types.ts'
import type { Resolver } from '../resolver.ts'
import type { DatabaseService } from '../service.ts'
import type { Personal } from './useViewQuery.ts'

export interface CreateRowOpts {
  title?: string
  context?: { propertyId: Id; cell: Cell }[]
  explicitValues?: Record<Id, Cell>
  parentItemId?: Id | null
  beforePageId?: Id | null
  /** open the new row in the editor of its title right away */
  edit?: boolean
}

export interface ViewCtl {
  /** merge into View.configuration (shared, saved) */
  patch(config: Record<string, Json>): Promise<boolean>
  personal: Personal | null
  setPersonal(p: Personal | null): void
  openFilterFor(propertyId: Id): void
  search: string
  createRow(o?: CreateRowOpts): Promise<{ pageId: Id; inView: boolean } | null>
  rs: Resolver
  notice(msg: string, action?: { label: string; run: () => void }): void
  openProperties(): void
  /** the viewer is allowed to change the shared schema / views */
  canSchema: boolean
  canEditRows: boolean
}

export interface ViewProps {
  svc: DatabaseService
  view: View
  container: Container
  ctl: ViewCtl
}
