import { describe, expect, it } from "vitest"

import { OVERRIDE_KEYS, overridesView, settleDefault } from "./view-overrides"

describe("overridesView", () => {
  it("is false for a bare view", () => {
    expect(overridesView({ view: "v1" })).toBe(false)
  })

  it("does not count the Find box as an edit", () => {
    expect(overridesView({ view: "v1", q: "core" })).toBe(false)
  })

  it("counts every other map setting", () => {
    expect(overridesView({ view: "v1", site: "s1" })).toBe(true)
    expect(overridesView({ view: "v1", q: "core", color: "speed" })).toBe(true)
    // No control sets it, but a stale one would be saved: still an edit.
    expect(overridesView({ view: "v1", cables: "curved" })).toBe(true)
    // The Diagram's stacking, and a hand-picked map's placed chassis.
    expect(overridesView({ view: "v1", stack: "h" })).toBe(true)
    expect(overridesView({ view: "v1", chassis: "c1" })).toBe(true)
  })

  it("still clears the search when a view is applied", () => {
    // Applying a view wipes every key in the list; the search is one.
    expect(OVERRIDE_KEYS).toContain("q")
    expect(OVERRIDE_KEYS).toContain("cables")
  })
})

describe("settleDefault", () => {
  it("opens the default on a bare address", () => {
    expect(settleDefault({}, "d1")).toEqual({ view: "d1" })
    expect(settleDefault({ site: undefined }, "d1")).toEqual({ view: "d1" })
  })

  it("keeps any other address on No view", () => {
    expect(settleDefault({ site: "s1" }, "d1")).toEqual({ view: "none" })
    expect(settleDefault({ device: "x", depth: 2 }, "d1")).toEqual({
      view: "none",
    })
    expect(settleDefault({ devices: "" }, "d1")).toEqual({ view: "none" })
    expect(settleDefault({ q: "core" }, "d1")).toEqual({ view: "none" })
  })

  it("leaves an address that names a view, or none", () => {
    expect(settleDefault({ view: "v1" }, "d1")).toBeNull()
    expect(settleDefault({ view: "none" }, "d1")).toBeNull()
    expect(settleDefault({ view: "none", site: "s1" }, "d1")).toBeNull()
  })

  it("changes nothing without a default", () => {
    expect(settleDefault({}, null)).toBeNull()
    expect(settleDefault({ site: "s1" }, null)).toBeNull()
  })
})
