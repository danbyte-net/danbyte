import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

/** Row delete/edit affordances must come from RowActions (or match its
 *  treatment): `size="icon"`, `h-7 w-7`, muted → destructive on hover. Before
 *  this test the codebase had four sizes (xs/sm/icon/icon-sm) and two colour
 *  treatments for the same trash can, so tables looked subtly different from
 *  each other. Labelled buttons ("Delete 3 boards") are unaffected - this only
 *  covers ICON-ONLY trash buttons. */
const SRC = join(process.cwd(), "src")

// Page-header Delete buttons carry a text label and are their own pattern.
const ALLOW = new Set<string>([
  // Bulk bars render a labelled destructive button, not a row icon.
  "components/ip-bulk-bar.tsx",
  "components/prefix-bulk-bar.tsx",
  "components/vlan-bulk-bar.tsx",
  "components/component-bulk-bar.tsx",
  "components/device-bulk-bar.tsx",
  "components/ipsec-profile-bulk-bar.tsx",
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full))
    else if (/\.tsx$/.test(e.name) && !e.name.endsWith(".test.tsx"))
      out.push(full)
  }
  return out
}

/** Opening <Button …> tags whose body renders a bare Trash2 and no text. */
function iconOnlyTrashButtons(src: string): string[] {
  const out: string[] = []
  const re = /<Button\b([^>]*)>([\s\S]{0,400}?)<\/Button>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const [, attrs, body] = m
    if (!/<Trash2\b/.test(body)) continue
    // Labelled buttons keep their own styling; only icon-only ones must match.
    const text = body
      .replace(/<[^>]*>/g, "")
      .replace(/\{[\s\S]*?\}/g, "")
      .trim()
    if (text) continue
    out.push(attrs)
  }
  return out
}

describe("row delete affordances", () => {
  it("icon-only trash buttons use the canonical size and colour", () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1).replace(/\\/g, "/")
      if (rel === "components/row-actions.tsx" || ALLOW.has(rel)) continue
      const src = readFileSync(file, "utf8")
      for (const attrs of iconOnlyTrashButtons(src)) {
        const sized = /size="icon"/.test(attrs) && /h-7 w-7/.test(attrs)
        // Always-red reads as an error state; the canonical treatment is
        // muted until hover.
        const coloured =
          /text-muted-foreground/.test(attrs) &&
          /hover:text-destructive/.test(attrs)
        if (!sized || !coloured) offenders.push(`${rel} :: ${attrs.trim()}`)
      }
    }
    expect(
      offenders,
      "Use <RowActions onDelete=…/> (or its treatment: size=\"icon\", " +
        'h-7 w-7, text-muted-foreground hover:text-destructive) for row trash icons.'
    ).toEqual([])
  })
})
