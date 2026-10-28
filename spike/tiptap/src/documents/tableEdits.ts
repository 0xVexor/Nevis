import type { EditNode } from './editPlanner.ts'

export interface TableCellPosition { cell: EditNode; row: number; column: number; rowspan: number; colspan: number }
/** Expand spans once, rejecting overlaps, holes and unbounded grids before a table mutation. */
export function tableGrid(table: EditNode): { width: number; cells: TableCellPosition[] } {
  const invalid = () => { throw Object.assign(new Error('Unsupported table shape'), { code: 'UNSUPPORTED_CONTENT' }) }
  const rows = table.content
  if (table.type !== 'table' || !rows?.length || rows.length > 100) return invalid()
  const grid: boolean[][] = Array.from({ length: rows.length }, () => []), cells: TableCellPosition[] = []
  for (const [r, row] of rows.entries()) {
    if (row.type !== 'tableRow' || !Array.isArray(row.content)) return invalid()
    let column = 0
    for (const cell of row.content) {
      if (!['tableCell', 'tableHeader'].includes(cell.type) || !cell.content?.length) return invalid()
      while (grid[r][column]) column++
      const rowspan = cell.attrs?.rowspan ?? 1, colspan = cell.attrs?.colspan ?? 1
      if (!Number.isInteger(rowspan) || !Number.isInteger(colspan) || Number(rowspan) < 1 || Number(colspan) < 1
        || r + Number(rowspan) > rows.length || column + Number(colspan) > 100) return invalid()
      const widths = cell.attrs?.colwidth
      if (widths !== undefined && widths !== null && (!Array.isArray(widths) || widths.length !== colspan || widths.some(w => !Number.isInteger(w) || w < 0))) return invalid()
      for (let y = r; y < r + Number(rowspan); y++) for (let x = column; x < column + Number(colspan); x++) {
        if (grid[y][x]) return invalid()
        grid[y][x] = true
      }
      cells.push({ cell, row: r, column, rowspan: Number(rowspan), colspan: Number(colspan) })
      column += Number(colspan)
    }
  }
  const width = Math.max(...grid.map(row => row.length))
  if (!width || grid.some(row => row.length !== width || Array.from({ length: width }, (_, x) => row[x]).some(value => !value))) return invalid()
  return { width, cells }
}
