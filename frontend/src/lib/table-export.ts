// Generic export for any TanStack-backed DataTable. Reads the table's visible
// columns (in the user's current order) and its filtered/sorted rows — or just
// the selected rows — and renders CSV, a self-contained shareable HTML page, or
// a print view (Save-as-PDF in the browser). Cells export off each column's
// accessor, with a `meta.export` escape hatch for rich cells.
import { type Table } from "@tanstack/react-table"

export type ExportFormat = "csv" | "xlsx" | "html" | "print"

interface ExportColumn {
  header: string
  get: (rowOriginal: unknown, getValue: (id: string) => unknown) => unknown
  id: string
}

// Columns that never carry exportable data.
const SKIP_IDS = new Set(["select", "actions"])

function prettify(id: string): string {
  return id.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function coerce(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  if (typeof v === "number" || typeof v === "boolean") return String(v)
  if (Array.isArray(v))
    return v
      .map((x) =>
        x && typeof x === "object" && "name" in x ? String(x.name) : coerce(x)
      )
      .join(", ")
  if (typeof v === "object") {
    const o = v as Record<string, unknown>
    return String(o.name ?? o.label ?? o.cidr ?? o.ip_address ?? "")
  }
  return String(v)
}

function exportColumns<T>(table: Table<T>): ExportColumn[] {
  const out: ExportColumn[] = []
  for (const col of table.getVisibleLeafColumns()) {
    if (SKIP_IDS.has(col.id)) continue
    const meta = col.columnDef.meta
    const hasAccessor =
      "accessorKey" in col.columnDef || "accessorFn" in col.columnDef
    if (!hasAccessor && !meta?.export) continue
    const header =
      meta?.export?.header ??
      (typeof col.columnDef.header === "string"
        ? col.columnDef.header
        : prettify(col.id))
    const valueFn = meta?.export?.value
    out.push({
      id: col.id,
      header,
      get: (rowOriginal, getValue) =>
        valueFn ? valueFn(rowOriginal as T) : getValue(col.id),
    })
  }
  return out
}

function exportRows<T>(table: Table<T>, columns: ExportColumn[]): string[][] {
  const selected = table
    .getSelectedRowModel()
    .flatRows.filter((r) => !r.getIsGrouped())
  const source = selected.length
    ? selected
    : table.getFilteredRowModel().flatRows.filter((r) => !r.getIsGrouped())
  return source.map((row) =>
    columns.map((c) => coerce(c.get(row.original, (id) => row.getValue(id))))
  )
}

export interface ExportOptions {
  /** File base name (no extension). */
  name: string
  /** Heading shown on the HTML/print page. */
  title: string
  /** Pre-stamped timestamp string (callers stamp it; keeps this pure). */
  generatedAt: string
}

function csvEscape(s: string): string {
  return `"${s.replace(/"/g, '""')}"`
}

export function toCsv(columns: ExportColumn[], rows: string[][]): string {
  const lines = [columns.map((c) => csvEscape(c.header)).join(",")]
  for (const r of rows) lines.push(r.map(csvEscape).join(","))
  return lines.join("\r\n")
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// Self-contained document — inline CSS only, so it can be saved and shared as a
// single file and prints cleanly to PDF.
export function toHtml(
  columns: ExportColumn[],
  rows: string[][],
  opts: ExportOptions
): string {
  const thead = columns.map((c) => `<th>${htmlEscape(c.header)}</th>`).join("")
  const tbody = rows
    .map(
      (r) =>
        `<tr>${r.map((cell) => `<td>${htmlEscape(cell)}</td>`).join("")}</tr>`
    )
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(opts.title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #18181b; background: #fff;
  }
  header { margin-bottom: 20px; }
  h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 4px; }
  .meta { font-size: 12px; color: #71717a; }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.06em; color: #71717a; font-weight: 600;
    padding: 6px 10px; border-bottom: 1px solid #e4e4e7; white-space: nowrap;
  }
  tbody td {
    padding: 6px 10px; border-bottom: 1px solid #f4f4f5;
    vertical-align: top; font-variant-numeric: tabular-nums;
  }
  tbody tr:nth-child(even) { background: #fafafa; }
  footer { margin-top: 16px; font-size: 11px; color: #a1a1aa; }
  @media print {
    body { padding: 0; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>
<header>
  <h1>${htmlEscape(opts.title)}</h1>
  <div class="meta">${rows.length} row${rows.length === 1 ? "" : "s"} · exported ${htmlEscape(opts.generatedAt)}</div>
</header>
<table>
  <thead><tr>${thead}</tr></thead>
  <tbody>${tbody}</tbody>
</table>
<footer>Generated by Danbyte</footer>
</body>
</html>`
}

export function downloadBlob(
  filename: string,
  mime: string,
  content: BlobPart
) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─── XLSX (real Office Open XML, no dependency) ──────────────────────────────
// An .xlsx is a ZIP of XML parts. We emit the minimal SpreadsheetML and pack it
// with a tiny store-only (uncompressed) ZIP writer — Excel/Sheets/LibreOffice
// all open stored zips. Everything is written as inline strings so values like
// CIDRs/IPs aren't mangled into numbers.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function zipStore(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const crc = crc32(e.data)
    const size = e.data.length
    const lh = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, 0, true) // store
    lv.setUint16(12, 0x21, true) // dummy date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    lh.set(nameBytes, 30)
    parts.push(lh, e.data)
    const ch = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(ch.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(14, 0x21, true) // dummy date
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    ch.set(nameBytes, 46)
    central.push(ch)
    offset += lh.length + size
  }
  const centralSize = central.reduce((a, c) => a + c.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  const blocks = [...parts, ...central, eocd]
  const total = blocks.reduce((a, b) => a + b.length, 0)
  const out = new Uint8Array(total)
  let p = 0
  for (const b of blocks) {
    out.set(b, p)
    p += b.length
  }
  return out
}

function colLetter(i: number): string {
  let s = ""
  let n = i + 1
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

function xmlEscape(s: string): string {
  return (
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;")
      // strip control chars Excel rejects (keep tab/newline/return)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  )
}

function sheetName(title: string): string {
  const cleaned = title.replace(/[\\/?*[\]:]/g, " ").trim() || "Export"
  return cleaned.slice(0, 31)
}

export function toXlsx(
  columns: ExportColumn[],
  rows: string[][],
  opts: ExportOptions
): Uint8Array {
  const cell = (ref: string, text: string) =>
    `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
  const headerRow = `<row r="1">${columns
    .map((c, i) => cell(`${colLetter(i)}1`, c.header))
    .join("")}</row>`
  const bodyRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 2}">${r.map((v, ci) => cell(`${colLetter(ci)}${ri + 2}`, v)).join("")}</row>`
    )
    .join("")
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${bodyRows}</sheetData></worksheet>`
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(sheetName(opts.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`
  const enc = new TextEncoder()
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(workbookRels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ])
}

function printHtml(html: string) {
  const win = window.open("", "_blank", "width=1024,height=768")
  if (!win) return
  win.document.open()
  win.document.write(html)
  win.document.close()
  // Give the new document a tick to lay out before invoking print.
  win.onload = () => {
    win.focus()
    win.print()
  }
  // Fallback if onload doesn't fire (already-loaded blank doc).
  setTimeout(() => {
    try {
      win.focus()
      win.print()
    } catch {
      /* user closed it */
    }
  }, 300)
}

/** Export a DataTable in the chosen format. Exports the selected rows when any
 * are ticked, otherwise every filtered/sorted row. */
export function exportTable<T>(
  table: Table<T>,
  format: ExportFormat,
  opts: ExportOptions
) {
  const columns = exportColumns(table)
  const rows = exportRows(table, columns)
  if (format === "csv") {
    downloadBlob(
      `${opts.name}.csv`,
      "text/csv;charset=utf-8",
      toCsv(columns, rows)
    )
    return
  }
  if (format === "xlsx") {
    downloadBlob(
      `${opts.name}.xlsx`,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      toXlsx(columns, rows, opts) as unknown as BlobPart
    )
    return
  }
  const html = toHtml(columns, rows, opts)
  if (format === "html") {
    downloadBlob(`${opts.name}.html`, "text/html;charset=utf-8", html)
  } else {
    printHtml(html)
  }
}
