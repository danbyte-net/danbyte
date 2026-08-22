import { describe, expect, it } from "vitest"

import type { TopologyViewSaved } from "@/lib/api"
import { migratePositions, viewPositions } from "./view-positions"

// A saved view holds one arrangement per view style in a single record, so a
// partial write is a delete: these guard the paths where arranging one view
// used to wipe another.

const styleOf = (raw: unknown) =>
  ["stencil", "hierarchy", "flat", "logical"].includes(raw as string)
    ? (raw as string)
    : "stencil"

const view = (state: Record<string, unknown>): TopologyViewSaved =>
  ({
    id: "v1",
    numid: 1,
    name: "big",
    state,
    created_at: "",
    updated_at: "",
  }) as TopologyViewSaved

describe("viewPositions", () => {
  it("reads the per-style arrangements when present", () => {
    const v = view({
      filters: { viewStyle: "hierarchy" },
      positions_by_style: {
        hierarchy: { "dev:a": [1, 2] },
        flat: { "dev:a": [9, 9] },
      },
      positions: { "dev:a": [1, 2] },
    })
    expect(viewPositions(v, styleOf)).toEqual({
      hierarchy: { "dev:a": [1, 2] },
      flat: { "dev:a": [9, 9] },
    })
  })

  it("attributes a pre-split view's single map to the style it was saved in", () => {
    const v = view({
      filters: { viewStyle: "flat" },
      positions: { "dev:a": [4, 5] },
    })
    expect(viewPositions(v, styleOf)).toEqual({ flat: { "dev:a": [4, 5] } })
  })

  it("keeps a tiered view's arrangements - discarding them used to make a later save delete them", () => {
    const v = view({
      filters: { viewStyle: "hierarchy", roleOrder: ["Core", "Access"] },
      positions_by_style: { hierarchy: { "dev:a": [1, 2] } },
    })
    expect(viewPositions(v, styleOf).hierarchy).toEqual({ "dev:a": [1, 2] })
  })

  it("has nothing to restore for a view saved on the rail diagram", () => {
    const v = view({
      filters: { viewStyle: "logical" },
      positions: { x: [0, 0] },
    })
    expect(viewPositions(v, styleOf)).toEqual({})
  })
})

describe("migratePositions", () => {
  it("reads a pre-split browser store as the style in use", () => {
    expect(migratePositions({ "dev:a": [1, 2] }, "hierarchy")).toEqual({
      hierarchy: { "dev:a": [1, 2] },
    })
  })

  it("passes a per-style store through untouched", () => {
    const store = { flat: { "dev:a": [1, 2] } }
    expect(migratePositions(store, "hierarchy")).toEqual(store)
  })

  it("survives junk in storage", () => {
    expect(migratePositions(null, "flat")).toEqual({})
    expect(migratePositions("nonsense", "flat")).toEqual({})
  })
})
