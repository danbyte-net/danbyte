/** One entry of a file's outline: a section header and the lines it spans.
 * Line numbers are 1-based; `end` is the section's last line (equal to
 * `line` when the header has no body to fold). */
export interface Section {
  title: string
  line: number
  end: number
  /** 0 = a file marker, 1 = a top-level block, 2 = a nested block. */
  level: number
}

const FILE_MARKER = /^###\s*FILE:\s*(.+?)\s*$/
const INI_SECTION = /^\[[^\]\s][^\]]*\]\s*$/
// Indented-block configs: FRR/IOS-style `interface`/`router`, ifupdown
// `iface`, and nested `address-family` inside a router block.
const BLOCK = /^(\s*)(interface|router|iface|vrf|address-family)\s+\S/

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

/** The sections a config file is made of, in order: `### FILE:` markers,
 * `[Section]` headers (systemd units, INI), and indented blocks such as
 * `interface …`, `router …` and `iface …`. Each carries the last line of
 * its body so the viewer can fold it. */
export function sectionsOf(text: string): Section[] {
  const lines = text.split("\n")
  const out: Section[] = []
  const n = lines.length

  for (let i = 0; i < n; i++) {
    const raw = lines[i]
    const file = FILE_MARKER.exec(raw)
    if (file) {
      let end = i
      for (let j = i + 1; j < n && !FILE_MARKER.test(lines[j]); j++) end = j
      out.push({
        title: file[1],
        line: i + 1,
        end: trimBlank(lines, i, end) + 1,
        level: 0,
      })
      continue
    }
    if (INI_SECTION.test(raw)) {
      let end = i
      for (let j = i + 1; j < n; j++) {
        if (INI_SECTION.test(lines[j]) || FILE_MARKER.test(lines[j])) break
        end = j
      }
      out.push({
        title: raw.trim(),
        line: i + 1,
        end: trimBlank(lines, i, end) + 1,
        level: 1,
      })
      continue
    }
    const block = BLOCK.exec(raw)
    if (block) {
      const depth = block[1].length
      // The body is every following line indented deeper than the header;
      // a blank line belongs to it only when the body carries on after it.
      let end = i
      for (let j = i + 1; j < n; j++) {
        const l = lines[j]
        if (l.trim() === "") continue
        if (indentOf(l) > depth) end = j
        else break
      }
      out.push({
        title: raw.trim(),
        line: i + 1,
        end: end + 1,
        level: depth > 0 ? 2 : 1,
      })
    }
  }
  return out
}

const JSON_OPEN = /^(\s*)(?:"((?:[^"\\]|\\.)*)"\s*:\s*)?[[{]\s*$/

/** The objects and arrays of pretty-printed JSON (two-space indent, as
 * `JSON.stringify(v, null, 2)` writes it), each to its closing bracket.
 * A key's level is its depth; the root (level 0) has no title. */
export function jsonSectionsOf(text: string): Section[] {
  const lines = text.split("\n")
  const out: Section[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = JSON_OPEN.exec(lines[i])
    if (!m) continue
    const depth = m[1].length
    const key = (m as unknown as (string | undefined)[])[2]
    let end = i
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (indentOf(l) === depth && /^\s*[\]}]/.test(l)) {
        end = j
        break
      }
    }
    if (end === i) continue
    out.push({
      title: key ?? (depth === 0 ? "" : lines[i].trim()),
      line: i + 1,
      end: end + 1,
      level: Math.floor(depth / 2),
    })
  }
  return out
}

/** Back `end` up over trailing blank lines, never past `start`. */
function trimBlank(lines: string[], start: number, end: number): number {
  while (end > start && lines[end].trim() === "") end--
  return end
}
