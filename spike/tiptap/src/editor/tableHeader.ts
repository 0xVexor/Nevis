/** Is the first row of the table around the cursor a header row (cells of type tableHeader)? */
export function hasHeaderRow(editor: any): boolean {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'table') return node.firstChild?.firstChild?.type.name === 'tableHeader'
  }
  return false
}

/** Is the first column a header column (first cell of every row is a tableHeader)? */
export function hasHeaderColumn(editor: any): boolean {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'table') {
      let all = node.childCount > 0
      node.forEach((row: any) => (all = all && row.firstChild?.type.name === 'tableHeader'))
      return all
    }
  }
  return false
}
