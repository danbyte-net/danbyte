import { describe, expect, it } from "vitest"

import { OVERRIDE_KEYS, overridesView } from "./view-overrides"

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
  })

  it("still clears the search when a view is applied", () => {
    // Applying a view wipes every key in the list; the search is one.
    expect(OVERRIDE_KEYS).toContain("q")
    expect(OVERRIDE_KEYS).toContain("cables")
  })
})
