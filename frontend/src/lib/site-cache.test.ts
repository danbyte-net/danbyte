import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { SITE_VIEW_KEYS, invalidateSiteViews } from "./site-cache"

const seeded = () => {
  const qc = new QueryClient()
  for (const key of [
    ["site-map"],
    ["site-map-connections"],
    ["site-map-cables"],
    ["sites", ""],
    ["sites", "by-region", "r1"],
    ["sites-picker"],
    ["site", "s1"],
    ["site", "s2"],
    ["cable-routes"],
    ["devices"],
  ])
    qc.setQueryData(key, {})
  return qc
}
const stale = (qc: QueryClient, key: unknown[]) =>
  qc.getQueryState(key)?.isInvalidated

describe("invalidateSiteViews", () => {
  it("drops the map payloads with the lists and pickers", () => {
    const qc = seeded()
    invalidateSiteViews(qc)
    expect(stale(qc, ["site-map"])).toBe(true)
    expect(stale(qc, ["site-map-connections"])).toBe(true)
    expect(stale(qc, ["site-map-cables"])).toBe(true)
    expect(stale(qc, ["sites", ""])).toBe(true)
    expect(stale(qc, ["sites", "by-region", "r1"])).toBe(true)
    expect(stale(qc, ["sites-picker"])).toBe(true)
    // Unrelated caches and untouched sites stay fresh.
    expect(stale(qc, ["cable-routes"])).toBe(false)
    expect(stale(qc, ["devices"])).toBe(false)
    expect(stale(qc, ["site", "s1"])).toBe(false)
  })

  it("drops the written sites' own queries only", () => {
    const qc = seeded()
    invalidateSiteViews(qc, ["s1"])
    expect(stale(qc, ["site", "s1"])).toBe(true)
    expect(stale(qc, ["site", "s2"])).toBe(false)
  })

  it("lists every map key, since site-map does not prefix-match the rest", () => {
    expect(SITE_VIEW_KEYS).toEqual(
      expect.arrayContaining([
        ["site-map"],
        ["site-map-connections"],
        ["site-map-cables"],
      ])
    )
  })
})

/**
 * Every source file that writes a site must refetch the site views through the
 * helper (or drop the whole cache), so a new write can't leave the map drawing
 * the old colour. The patterns match the write shapes in use: bulk endpoints,
 * the create endpoint handed to a form, and a POST/PATCH/DELETE call.
 *
 * Applying a planned site or region change posts to the generic planning
 * endpoint, which these patterns can't see; planned-change-panel.test.tsx
 * covers that path.
 */
describe("site writes", () => {
  const SRC = join(import.meta.dirname, "..")
  const WRITES = [
    /\/api\/sites\/bulk-(?:update|delete)\//,
    /endpoint(?:=|:\s*)"\/api\/sites\/"/,
    /`\/api\/sites\/\$\{[^}]+\}\/`,\s*\{\s*method:/,
    /"\/api\/sites\/",\s*\{\s*method:/,
  ]
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      if (e.isDirectory()) return sources(p)
      return /\.tsx?$/.test(e.name) && !/\.test\.|routeTree\.gen/.test(e.name)
        ? [p]
        : []
    })
  const writers = sources(SRC)
    .map((p) => ({ path: relative(SRC, p), text: readFileSync(p, "utf8") }))
    .filter((f) => WRITES.some((re) => re.test(f.text)))

  it("finds the known writers", () => {
    const paths = writers.map((f) => f.path)
    for (const known of [
      "components/site-form.tsx",
      "components/site-delete-dialog.tsx",
      "components/site-bulk-bar.tsx",
      "routes/sites.bulk-edit.tsx",
      "routes/site-map.tsx",
    ])
      expect(paths).toContain(known)
  })

  it("refetch the site views after writing", () => {
    const missing = writers
      .filter(
        (f) =>
          !/invalidateSiteViews|SITE_VIEW_KEYS|invalidateQueries\(\)/.test(
            f.text
          )
      )
      .map((f) => f.path)
    expect(missing).toEqual([])
  })
})
