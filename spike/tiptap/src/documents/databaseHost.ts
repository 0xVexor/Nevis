/** What the MCP session needs from the database feature; the implementation lives in database/mcpTools.ts. */
export interface DatabaseAccess {
  canRead(id: string): boolean
  canWrite(id: string): boolean
  canCreate(parentId: string | null): boolean
}
export type DatabasePropertySpec = { name: string; kind: string; options?: string[] }
export type DatabaseRowSpec = { title?: string; values?: Record<string, unknown> }
export interface DatabaseToolHost {
  createDatabase(input: { operationId: string; parentId: string | null; title: string; properties?: DatabasePropertySpec[]; rows?: DatabaseRowSpec[] }, access: DatabaseAccess): Promise<unknown>
  addRows(input: { operationId: string; sourceId: string; rows: DatabaseRowSpec[] }, access: DatabaseAccess): Promise<unknown>
  list(canRead: (id: string) => boolean): Promise<unknown>
  describe(sourceId: string, canRead: (id: string) => boolean): Promise<unknown>
  rows(input: { sourceId: string; limit?: number; cursor?: string }, canRead: (id: string) => boolean): Promise<unknown>
}
