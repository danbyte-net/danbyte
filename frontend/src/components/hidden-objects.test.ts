import { describe, expect, it } from "vitest"

import {
  emptyHidden,
  hiddenCount,
  isHidden,
  normalizeHidden,
  setHidden,
} from "./hidden-objects"

const KEYS = ["roles", "sites"] as const

describe("hidden-objects", () => {
  it("counts across every key", () => {
    const h = { roles: ["a", "b"], sites: ["s1"] }
    expect(hiddenCount(h)).toBe(3)
    expect(hiddenCount(emptyHidden(KEYS))).toBe(0)
  })

  it("toggles without mutating and ignores no-ops", () => {
    const h = emptyHidden(KEYS)
    const on = setHidden(h, "roles", "Core", true)
    expect(on).not.toBe(h)
    expect(isHidden(on, "roles", "Core")).toBe(true)
    expect(setHidden(on, "roles", "Core", true)).toBe(on)
    const off = setHidden(on, "roles", "Core", false)
    expect(off.roles).toEqual([])
    expect(h.roles).toEqual([])
  })

  it("normalises stored shapes, old flat lists included", () => {
    expect(normalizeHidden({ roles: ["x"], junk: 1 }, KEYS)).toEqual({
      roles: ["x"],
      sites: [],
    })
    expect(
      normalizeHidden(["d1", "d2"], ["devices", "roles"] as const, "devices")
    ).toEqual({
      devices: ["d1", "d2"],
      roles: [],
    })
    expect(normalizeHidden(null, KEYS)).toEqual({ roles: [], sites: [] })
    expect(normalizeHidden({ roles: "nope" }, KEYS)).toEqual({
      roles: [],
      sites: [],
    })
  })
})
