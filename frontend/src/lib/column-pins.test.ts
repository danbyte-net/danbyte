import { describe, expect, it } from "vitest"

import {
  PIN_MIN_FRAME,
  leftPinOrder,
  pinLayout,
  samePinLayout,
  togglePin,
} from "./column-pins"

const opts = (over: Partial<Parameters<typeof leftPinOrder>[1]> = {}) => ({
  hasSelect: true,
  isShown: () => true,
  canPin: () => true,
  frameWidth: 1200,
  ...over,
})

describe("leftPinOrder", () => {
  it("puts the selection column first, then the pins in pin order", () => {
    expect(leftPinOrder(["site", "name"], opts())).toEqual([
      "select",
      "site",
      "name",
    ])
  })

  it("pins nothing - not even the tick - when no column is pinned", () => {
    expect(leftPinOrder([], opts())).toEqual([])
  })

  it("leaves out hidden, unpinnable and repeated ids", () => {
    expect(
      leftPinOrder(["actions", "name", "gone", "name", "select", "site"], {
        ...opts(),
        isShown: (id) => id !== "gone",
        canPin: (id) => id !== "site",
      })
    ).toEqual(["select", "name"])
  })

  it("ignores pins in a narrow frame", () => {
    expect(
      leftPinOrder(["name"], opts({ frameWidth: PIN_MIN_FRAME - 1 }))
    ).toEqual([])
    // Unmeasured (0) is not narrow.
    expect(leftPinOrder(["name"], opts({ frameWidth: 0 }))).toEqual([
      "select",
      "name",
    ])
  })

  it("has no tick column to add on a table without selection", () => {
    expect(leftPinOrder(["name"], opts({ hasSelect: false }))).toEqual(["name"])
  })
})

describe("pinLayout", () => {
  it("sticks each pinned column where the ones before it end", () => {
    const l = pinLayout(["select", "name", "site"], [36, 180, 120], 1200)
    expect(l.left).toEqual({ select: 0, name: 36, site: 216 })
    expect(l.last).toBe("site")
  })

  it("stops sticking once the band would pass 60% of the frame", () => {
    // cap = 600: select + name = 516 fits, + site (120) = 636 does not.
    const l = pinLayout(["select", "name", "site"], [36, 480, 120], 1000)
    expect(l.left).toEqual({ select: 0, name: 36 })
    expect(l.last).toBe("name")
  })

  it("sticks nothing when the first pin alone is too wide", () => {
    const l = pinLayout(["name"], [700], 1000)
    expect(l).toEqual({ left: {}, last: null })
  })

  it("compares layouts by value", () => {
    const a = pinLayout(["a", "b"], [10, 20], 1000)
    expect(samePinLayout(a, pinLayout(["a", "b"], [10, 20], 1000))).toBe(true)
    expect(samePinLayout(a, pinLayout(["a", "b"], [10, 25], 1000))).toBe(true)
    expect(samePinLayout(a, pinLayout(["a", "b"], [12, 20], 1000))).toBe(false)
  })
})

describe("togglePin", () => {
  it("adds after the existing pins and removes in place", () => {
    expect(togglePin(["a"], "b")).toEqual(["a", "b"])
    expect(togglePin(["a", "b", "c"], "b")).toEqual(["a", "c"])
  })
})
