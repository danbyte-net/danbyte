import { describe, expect, it } from "vitest"

import type { TopoEdge } from "@/lib/api"
import { groupLagEdges, lagBundleLabel, sharedLag } from "./lag-bundles"

const po1 = { id: "p1", name: "Po1" }
const po10 = { id: "p10", name: "Po10" }
const po11 = { id: "p11", name: "Po11" }

function cable(id: string, lag?: { a: typeof po1 | null; b: typeof po10 | null }): TopoEdge {
  return {
    id,
    source: "dev:a",
    target: "dev:b",
    type: "cable",
    data: { cable_id: id, pairs: [], ...(lag ? { lag } : {}) },
  }
}

describe("groupLagEdges", () => {
  it("folds cables sharing both aggregates and leaves the rest in place", () => {
    const plain = cable("c3")
    const half = cable("c4", { a: po1, b: null })
    const { bundles, rest } = groupLagEdges([
      cable("c1", { a: po1, b: po10 }),
      plain,
      cable("c2", { a: po1, b: po10 }),
      half,
    ])
    expect(bundles).toHaveLength(1)
    expect(bundles[0].edges.map((e) => e.id)).toEqual(["c1", "c2"])
    expect(rest).toEqual([plain, half])
  })

  it("keeps one bundle per far-end aggregate (vPC / MLAG)", () => {
    const { bundles } = groupLagEdges([
      cable("c1", { a: po1, b: po10 }),
      cable("c2", { a: po1, b: po11 }),
    ])
    expect(bundles.map((b) => b.lag.b.name)).toEqual(["Po10", "Po11"])
  })

  it("labels and shared-lag detection", () => {
    expect(lagBundleLabel({ a: po1, b: po10 }, 2)).toBe("Po1 ⇄ Po10 ×2")
    expect(sharedLag([{ lag: { a: po1, b: po10 } }, { lag: { a: po1, b: po10 } }])).toEqual({
      a: po1,
      b: po10,
    })
    expect(sharedLag([{ lag: { a: po1, b: po10 } }, { lag: { a: po1, b: po11 } }])).toBeNull()
    expect(sharedLag([{}])).toBeNull()
  })
})
