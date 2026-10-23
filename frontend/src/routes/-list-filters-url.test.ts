import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

// ─── List filters live in the URL ────────────────────────────────────────
//
// Every list page keeps its facet selections, its search box and its
// advanced filter in the query string (lib/url-filters), so reload, Back and a
// shared link keep them. A page that holds one in plain React state forgets
// it on reload - this audit fails on that, the way -table-registry.test.ts
// guards table ids.

const ROUTES = dirname(fileURLToPath(import.meta.url))
const SRC = join(ROUTES, "..")

/** The list pages: every `/things` index route, the shared routing list, and
 * the list pages that are not index routes. */
const LIST_PAGES = [
  ...readdirSync(ROUTES)
    .filter((n) => n.endsWith(".index.tsx"))
    .map((n) => `routes/${n}`),
  "components/routing/catalog-page.tsx",
  "routes/fiber-cables.tsx",
  "routes/lifecycle.tsx",
  "routes/port-utilization.tsx",
  "routes/saved-filters.tsx",
  "routes/monitoring-engines.tsx",
]

const FILES = LIST_PAGES.map((path) => ({
  path,
  text: readFileSync(join(SRC, path), "utf8"),
}))

describe("list filters", () => {
  it("never keep a facet selection in useState", () => {
    const bad = FILES.filter((f) =>
      /useState<Set<string>>\(|useState\(new Set/.test(f.text)
    ).map((f) => f.path)
    expect(bad).toEqual([])
  })

  it("use the URL-backed rail, not the embedded-table one", () => {
    const bad = FILES.filter((f) => /\buseTableFilters\(/.test(f.text)).map(
      (f) => f.path
    )
    expect(bad).toEqual([])
  })

  it("keep the header search box in the URL", () => {
    const bad: string[] = []
    for (const f of FILES) {
      for (const m of f.text.matchAll(/search=\{\{\s*value:\s*(\w+)/g)) {
        const name = m[1]
        const decl = new RegExp(`const \\[${name},\\s*\\w+\\] = useState\\(`)
        if (decl.test(f.text)) bad.push(`${f.path} (${name})`)
      }
    }
    expect(bad).toEqual([])
  })
})
