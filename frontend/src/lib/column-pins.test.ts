import { describe, expect, it } from "vitest"

import {
  PIN_MIN_FRAME,
  lastStuck,
  pinLayout,
  pinnedColumns,
  samePinLayout,
  togglePin,
} from "./column-pins"

const opts = (over: Partial<Parameters<typeof pinnedColumns>[1]> = {}) => ({
  hasSelect: true,
  isShown: () => true,
  canPin: () => true,
  frameWidth: 1200,
  ...over,
})
const set = (s: Set<string>) => [...s].sort()

describe("pinnedColumns", () => {
  it("is the shown pins plus the selection column", () => {
    expect(set(pinnedColumns(["site", "name"], opts()))).toEqual([
      "name",
      "select",
      "site",
    ])
  })

  it("pins nothing - not even the tick - when no column is pinned", () => {
    expect(pinnedColumns([], opts()).size).toBe(0)
  })

  it("leaves out hidden and unpinnable ids", () => {
    expect(
      set(
        pinnedColumns(["actions", "name", "gone", "select", "site"], {
          ...opts(),
          isShown: (id) => id !== "gone",
          canPin: (id) => id !== "site",
        })
      )
    ).toEqual(["name", "select"])
  })

  it("ignores pins in a narrow frame, but not while unmeasured", () => {
    expect(
      pinnedColumns(["name"], opts({ frameWidth: PIN_MIN_FRAME - 1 })).size
    ).toBe(0)
    expect(pinnedColumns(["name"], opts({ frameWidth: 0 })).size).toBe(2)
  })

  it("has no tick column to add on a table without selection", () => {
    expect(set(pinnedColumns(["name"], opts({ hasSelect: false })))).toEqual([
      "name",
    ])
  })
})

const cols = (...w: [string, number][]) =>
  w.map(([id, width]) => ({ id, width }))

describe("pinLayout", () => {
  it("keeps each pin in place and stacks it after the pins before it", () => {
    const l = pinLayout(
      cols(["select", 36], ["name", 180], ["type", 200], ["coverage", 120]),
      new Set(["select", "name", "coverage"]),
      1200
    )
    expect(l.left).toEqual({ select: 0, name: 36, coverage: 216 })
    expect(l.natural).toEqual({ select: 0, name: 36, coverage: 416 })
  })

  it("lets the pins past 60% of the frame scroll", () => {
    // cap = 600: select + name = 516 fits, + site (120) = 636 does not.
    const l = pinLayout(
      cols(["select", 36], ["name", 480], ["site", 120], ["role", 50]),
      new Set(["select", "name", "site", "role"]),
      1000
    )
    expect(Object.keys(l.left)).toEqual(["select", "name"])
  })

  it("compares layouts by value", () => {
    const c = cols(["a", 10], ["b", 20])
    const a = pinLayout(c, new Set(["a", "b"]), 1000)
    expect(samePinLayout(a, pinLayout(c, new Set(["a", "b"]), 1000))).toBe(true)
    expect(
      samePinLayout(
        a,
        pinLayout(cols(["a", 12], ["b", 20]), new Set(["a", "b"]), 1000)
      )
    ).toBe(false)
  })
})

describe("lastStuck", () => {
  const l = pinLayout(
    cols(["select", 40], ["name", 160], ["type", 300], ["coverage", 100]),
    new Set(["select", "name", "coverage"]),
    1200
  )
  it("is nothing before any scrolling", () => {
    expect(lastStuck(l, 0)).toBeNull()
  })
  it("is the tick and its in-place neighbour once scrolled", () => {
    // name is right after the tick: it sticks with the first pixel.
    expect(lastStuck(l, 10)).toBe("name")
  })
  it("moves to a mid-table pin once it is scrolled past", () => {
    // coverage starts at 500 and sticks at 200: stuck past 300.
    expect(lastStuck(l, 299)).toBe("name")
    expect(lastStuck(l, 320)).toBe("coverage")
  })
})

describe("togglePin", () => {
  it("adds and removes", () => {
    expect(togglePin(["a"], "b")).toEqual(["a", "b"])
    expect(togglePin(["a", "b", "c"], "b")).toEqual(["a", "c"])
  })
})
