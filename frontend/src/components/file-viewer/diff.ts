/** A line of a diff with its number on each side (null on the side it is
 * not on). */
export interface DiffLineRow {
  kind: "context" | "add" | "del"
  text: string
  old: number | null
  new: number | null
}

/** Unchanged lines left out of the view. */
export interface GapRow {
  kind: "gap"
  hidden: number
}

export type DiffRow = DiffLineRow | GapRow

export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  rows: DiffLineRow[]
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The hunks of a unified diff, numbered on both sides. File headers
 * (`---`/`+++`) and `\ No newline` notes are dropped. */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  let cur: Hunk | null = null
  let oldNo = 0
  let newNo = 0
  let remOld = 0
  let remNew = 0
  for (const line of diff.split("\n")) {
    if (cur && (remOld > 0 || remNew > 0)) {
      if (line.startsWith("\\")) continue
      const mark = line.charAt(0) || " "
      const text = line.slice(1)
      if (mark === "+") {
        cur.rows.push({ kind: "add", text, old: null, new: newNo++ })
        remNew--
      } else if (mark === "-") {
        cur.rows.push({ kind: "del", text, old: oldNo++, new: null })
        remOld--
      } else {
        // A context line; some tools strip its leading space when blank.
        cur.rows.push({ kind: "context", text, old: oldNo++, new: newNo++ })
        remOld--
        remNew--
      }
      continue
    }
    const m = HUNK.exec(line)
    if (!m) continue
    // A count left out of the header means one line.
    const [, os, oc, ns, nc] = m as unknown as (string | undefined)[]
    cur = {
      oldStart: Number(os),
      oldLines: oc === undefined ? 1 : Number(oc),
      newStart: Number(ns),
      newLines: nc === undefined ? 1 : Number(nc),
      rows: [],
    }
    hunks.push(cur)
    oldNo = cur.oldStart
    newNo = cur.newStart
    remOld = cur.oldLines
    remNew = cur.newLines
  }
  return hunks
}

/** A text's lines the way Python's `splitlines()` counts them: a trailing
 * newline does not start another line. */
export function linesOf(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  if (lines[lines.length - 1] === "") lines.pop()
  return lines
}

/** The last unchanged line before a hunk on one side: a hunk that removes
 * every line on a side (`,0`) names the line it follows, not its first. */
function before(start: number, count: number): number {
  return count === 0 ? start : start - 1
}

/** Every row of the diff. Given the new text, the unchanged stretches
 * between hunks are filled in from it, so the whole file reads through;
 * without it they become gaps. */
export function diffRows(diff: string, newText?: string | null): DiffRow[] {
  const hunks = parseHunks(diff)
  const rows: DiffRow[] = []
  const lines = newText == null ? null : linesOf(newText)
  let newNo = 1
  let oldNo = 1
  for (const h of hunks) {
    const upto = before(h.newStart, h.newLines)
    const count = upto - newNo + 1
    if (count > 0) {
      if (lines) {
        for (let k = 0; k < count; k++)
          rows.push({
            kind: "context",
            text: lines[newNo + k - 1] ?? "",
            old: oldNo + k,
            new: newNo + k,
          })
      } else rows.push({ kind: "gap", hidden: count })
    }
    rows.push(...h.rows)
    newNo = upto + 1 + h.newLines
    oldNo = before(h.oldStart, h.oldLines) + 1 + h.oldLines
  }
  if (lines && hunks.length > 0) {
    for (let k = newNo; k <= lines.length; k++)
      rows.push({
        kind: "context",
        text: lines[k - 1],
        old: oldNo + (k - newNo),
        new: k,
      })
  }
  return rows
}

/** Only the changes, with `context` unchanged lines either side; every
 * other unchanged run becomes one gap row. */
export function collapseContext(rows: DiffRow[], context = 3): DiffRow[] {
  const changed = rows.map((r) => r.kind === "add" || r.kind === "del")
  // Distance (in rows) to the nearest change, both directions.
  const dist = new Array<number>(rows.length).fill(Infinity)
  let last = -Infinity
  for (let i = 0; i < rows.length; i++) {
    if (changed[i]) last = i
    else if (rows[i].kind === "gap") last = -Infinity
    dist[i] = i - last
  }
  last = Infinity
  for (let i = rows.length - 1; i >= 0; i--) {
    if (changed[i]) last = i
    else if (rows[i].kind === "gap") last = Infinity
    dist[i] = Math.min(dist[i], last - i)
  }
  const out: DiffRow[] = []
  const hide = (n: number) => {
    const prev = out.length > 0 ? out[out.length - 1] : null
    if (prev?.kind === "gap") prev.hidden += n
    else out.push({ kind: "gap", hidden: n })
  }
  rows.forEach((r, i) => {
    if (r.kind === "gap") hide(r.hidden)
    else if (dist[i] <= context) out.push(r)
    else hide(1)
  })
  return out
}

export type SideRow =
  { kind: "pair"; left: DiffLineRow | null; right: DiffLineRow | null } | GapRow

/** The rows laid out side by side: unchanged lines on both sides, and each
 * run of removed lines paired with the added lines that follow it. */
export function sideBySide(rows: DiffRow[]): SideRow[] {
  const out: SideRow[] = []
  let i = 0
  while (i < rows.length) {
    const r = rows[i]
    if (r.kind === "gap") {
      out.push({ ...r })
      i++
      continue
    }
    if (r.kind === "context") {
      out.push({ kind: "pair", left: r, right: r })
      i++
      continue
    }
    const dels: DiffLineRow[] = []
    const adds: DiffLineRow[] = []
    while (i < rows.length && rows[i].kind === "del")
      dels.push(rows[i++] as DiffLineRow)
    while (i < rows.length && rows[i].kind === "add")
      adds.push(rows[i++] as DiffLineRow)
    for (let k = 0; k < Math.max(dels.length, adds.length); k++)
      out.push({ kind: "pair", left: dels[k] ?? null, right: adds[k] ?? null })
  }
  return out
}

/** How a gap row reads in the viewer. */
export function gapLabel(hidden: number): string {
  return `… ${hidden} unchanged line${hidden === 1 ? "" : "s"}`
}
