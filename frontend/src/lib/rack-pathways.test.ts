import { describe, expect, it } from "vitest"

import type { ResolvedPathway } from "@/lib/api"
import {
  changedPayload,
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
