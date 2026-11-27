import { describe, expect, it } from "vitest"

import type { ResolvedPathway } from "@/lib/api"
import {
  addPreset,
  changedPayload,
  dragSpan,
  freeRun,
  onFace,
  sideLanes,
  formOf,
  fullPayload,
  isOwn,
  resetPayload,
  sizeText,
  unitsText,
  whereText,
} from "./rack-pathways"

function pathway(patch: Partial<ResolvedPathway> = {}): ResolvedPathway {
  return {
    key: "path:vertical:left:rear",
    id: null,
    source: "kit",
    kind: "vertical",
    subkind: "channel",
    side: "left",
    face: "rear",
    surface: "",
    u_from: 1,
    u_to: 42,
    offset_mm: null,
    depth_mm: null,
    x_mm: null,
    y_mm: null,
    inner_w_mm: 52,
    inner_d_mm: 88,
    fill_limit_pct: 40,
    name: "",
    description: "",
    label: "Left rear",
    hidden: false,
    addon: false,
    orphan: false,
    overridden: [],
    accessory_type: null,
    device: null,
    ...patch,
  }
}

describe("rack pathway labels", () => {
  it("reads where it is", () => {
    expect(whereText(pathway())).toBe("Left rear")
    expect(whereText(pathway({ face: "full" }))).toBe("Left full depth")
    expect(
      whereText(pathway({ kind: "entry", surface: "top", side: "" }))
    ).toBe("Roof")
    expect(
      whereText(pathway({ kind: "entry", surface: "side", side: "right" }))
    ).toBe("Side panel right")
  })

  it("reads its units and size", () => {
    expect(unitsText(pathway())).toBe("U1-U42")
    expect(unitsText(pathway({ u_to: 1 }))).toBe("U1")
    expect(unitsText(pathway({ u_from: null, u_to: null }))).toBe("")
    expect(sizeText(pathway())).toBe("52 × 88 mm")
    expect(sizeText(pathway({ inner_w_mm: null, inner_d_mm: null }))).toBe("")
  })
})

describe("rack pathway payloads", () => {
  it("an inherited pathway's overlay carries only what changed", () => {
    const initial = formOf(pathway())
    expect(initial.fill_limit_pct).toBe("")
    const form = { ...initial, inner_w_mm: "60", name: "Left " }
    expect(changedPayload(initial, form)).toEqual({
      inner_w_mm: 60,
      name: "Left",
    })
    // Cleared: back to inheriting.
    expect(changedPayload(initial, { ...initial, inner_d_mm: "" })).toEqual({
      inner_d_mm: null,
    })
  })

  it("a changed fill limit shows", () => {
    expect(formOf(pathway({ fill_limit_pct: 50 })).fill_limit_pct).toBe("50")
    expect(
      formOf(pathway({ fill_limit_pct: 40, overridden: ["fill_limit_pct"] }))
        .fill_limit_pct
    ).toBe("40")
  })

  it("a pathway of its own sends every field", () => {
    const p = fullPayload({
      ...formOf(null),
      kind: "entry",
      surface: "top",
      inner_w_mm: "200",
    })
    expect(p).toMatchObject({
      kind: "entry",
      surface: "top",
      inner_w_mm: 200,
      u_from: null,
    })
  })

  it("a reset clears every field and the hidden flag", () => {
    const r = resetPayload()
    expect(r.hidden).toBeNull()
    expect(r.inner_w_mm).toBeNull()
    expect(r.name).toBe("")
    expect("kind" in r).toBe(false)
  })

  it("knows its own rows from inherited ones", () => {
    expect(
      isOwn(pathway({ source: "manual", id: "a", key: "manual:a" }), "rack")
    ).toBe(true)
    expect(
      isOwn(pathway({ source: "type", id: null, key: "type:b" }), "rack")
    ).toBe(false)
    expect(
      isOwn(pathway({ source: "type", id: "b", key: "type:b" }), "type")
    ).toBe(true)
    expect(isOwn(pathway({ id: "c" }), "type")).toBe(false)
  })
})

describe("on the elevation", () => {
  const rearLeft = pathway()
  const fullLeft = pathway({
    key: "path:vertical:left:full",
    face: "full",
    u_from: 20,
    u_to: 30,
  })
  const channel = pathway({
    key: "channel:0u:left:rear",
    kind: "channel",
    subkind: "",
    u_from: 1,
    u_to: 40,
  })

  it("draws a face's own, full-depth and entries, not hidden ones", () => {
    expect(onFace(rearLeft, "rear")).toBe(true)
    expect(onFace(rearLeft, "front")).toBe(false)
    expect(onFace(fullLeft, "front")).toBe(true)
    expect(onFace(pathway({ hidden: true }), "rear")).toBe(false)
    expect(
      onFace(pathway({ kind: "entry", surface: "top", u_from: null }), "front")
    ).toBe(true)
    expect(
      onFace(pathway({ kind: "entry", surface: "side", u_from: null }), "front")
    ).toBe(false)
  })

  it("puts overlapping ones in lanes, managers nearest the rails", () => {
    const { lanes, placed } = sideLanes(
      [channel, fullLeft, rearLeft],
      "left",
      "rear"
    )
    expect(lanes).toBe(3)
    expect(placed.map((x) => [x.p.key, x.lane])).toEqual([
      ["path:vertical:left:rear", 0],
      ["path:vertical:left:full", 1],
      ["channel:0u:left:rear", 2],
    ])
    // Not overlapping: one lane.
    const low = pathway({ u_from: 1, u_to: 10 })
    const high = pathway({ key: "x", u_from: 11, u_to: 42 })
    expect(sideLanes([low, high], "left", "rear").lanes).toBe(1)
  })

  it("finds the free run around a unit", () => {
    const spans = [
      { lo: 1, hi: 4 },
      { lo: 20, hi: 42 },
    ]
    expect(freeRun(spans, 10, 1, 42)).toEqual({ lo: 5, hi: 19 })
    expect(freeRun(spans, 3, 1, 42)).toBeNull()
    expect(freeRun([], 3, 1, 42)).toEqual({ lo: 1, hi: 42 })
  })

  it("adds a manager in a free run, else a channel", () => {
    const low = pathway({ u_from: 1, u_to: 10 })
    expect(addPreset([low], "left", "rear", 15, 1, 42)).toEqual({
      kind: "vertical",
      side: "left",
      face: "rear",
      u_from: "11",
      u_to: "42",
    })
    expect(addPreset([low], "left", "rear", 5, 1, 42)).toMatchObject({
      kind: "channel",
      u_from: "1",
      u_to: "42",
    })
  })

  it("spans a dragged end from the end that stays", () => {
    expect(dragSpan(1, 30)).toEqual({ u_from: 1, u_to: 30 })
    expect(dragSpan(30, 5)).toEqual({ u_from: 5, u_to: 30 })
  })
})
