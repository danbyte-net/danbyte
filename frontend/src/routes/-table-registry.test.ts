import { readFileSync, readdirSync, statSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { REGISTERED_TABLES } from "@/lib/tables"

// ─── The table-registry audit (#243) ─────────────────────────────────────
//
// Every table that saves a column layout is listed in lib/tables.ts, with the
// list endpoint its rows come from (`api`, or null when the rows are not one
// list's rows). That entry is what lets DataTable offer the list's other
// fields and custom fields as columns, and what puts the table in Admin →
// Table defaults. Lives in `routes/` next to the pages it guards; the leading
// `-` keeps TanStack's generator from turning it into a route.

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..")

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const FILES = sources(SRC).map((p) => ({
  path: relative(SRC, p),
  text: readFileSync(p, "utf8"),
}))

/** `tableId="x"` on a <DataTable>, and `tableId: "x"` in a spec object. */
const LITERAL = /tableId(?:=\{?|:\s*)"([^"]+)"/g
/** `tableId={`…${…}…`}` - an id built at runtime. */
const TEMPLATE = /tableId=\{`[^`]*\$\{/g

describe("the table registry", () => {
  const registered = new Map(REGISTERED_TABLES.map((t) => [t.id, t]))

  it("lists every literal tableId", () => {
    const missing: string[] = []
    for (const f of FILES) {
      if (f.path === "lib/tables.ts") continue
      for (const m of f.text.matchAll(LITERAL))
        if (!registered.has(m[1])) missing.push(`${m[1]} (${f.path})`)
    }
    expect(missing).toEqual([])
  })

  it("has one entry per id, each deciding its api", () => {
    const ids = REGISTERED_TABLES.map((t) => t.id)
    expect(ids.length).toBe(new Set(ids).size)
    for (const t of REGISTERED_TABLES) {
      expect(t).toHaveProperty("api")
      if (t.api !== null) expect(t.api).toMatch(/^\/api\/[a-z0-9/_-]+\/$/)
      expect(t.id).toMatch(/^[a-z0-9_-]+$/)
    }
  })

  it("makes a runtime-built id say where its columns come from", () => {
    // A template id cannot be a registry entry, so the table must pass
    // `autoColumns` itself - an api path, or `false`.
    const silent: string[] = []
    for (const f of FILES) {
      for (const m of f.text.matchAll(TEMPLATE)) {
        const el = f.text.slice(
          f.text.lastIndexOf("<DataTable", m.index),
          f.text.indexOf("/>", m.index)
        )
        if (!el.includes("autoColumns")) silent.push(f.path)
      }
    }
    expect(silent).toEqual([])
  })
})
