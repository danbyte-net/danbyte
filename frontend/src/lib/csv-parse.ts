/** Parse RFC 4180 CSV into rows of cells.
 *
 * Scripts write their results with `run.output_csv`, and a file you have to
 * download to read is not an answer. Quoted fields carry commas, newlines
 * and doubled quotes, so a split on "," is wrong often enough to matter.
 */
export function parseCsv(text: string, maxRows = 500): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  // A trailing newline is the normal ending, not an empty last row.
  const source = text.replace(/\r\n/g, "\n").replace(/\n$/, "")

  const endCell = () => {
    row.push(cell)
    cell = ""
  }
  const endRow = () => {
    endCell()
    rows.push(row)
    row = []
  }

  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      if (c !== '"') {
        cell += c
      } else if (source[i + 1] === '"') {
        cell += '"'
        i++
      } else {
        quoted = false
      }
      continue
    }
    if (c === '"' && cell === "") quoted = true
    else if (c === ",") endCell()
    else if (c === "\n") {
      endRow()
      if (rows.length >= maxRows) return rows
    } else cell += c
  }
  if (cell !== "" || row.length) endRow()
  return rows
}
