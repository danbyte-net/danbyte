import { describe, expect, it } from "vitest"

import { byNatural, compareValues, naturalCompare } from "./natural-sort"

describe("naturalCompare", () => {
  it("orders numbers inside names by value", () => {
    const names = ["DIMM 10", "DIMM 2", "DIMM 11", "DIMM 1", "DIMM 3"]
    expect([...names].sort(naturalCompare)).toEqual([
      "DIMM 1",
      "DIMM 2",
      "DIMM 3",
      "DIMM 10",
      "DIMM 11",
    ])
    const ports = ["Ethernet1/10", "Ethernet1/2", "Ethernet2/1", "Ethernet1/1"]
    expect([...ports].sort(naturalCompare)).toEqual([
      "Ethernet1/1",
      "Ethernet1/2",
      "Ethernet1/10",
      "Ethernet2/1",
    ])
  })

  it("ignores case and reads null as empty", () => {
    expect(naturalCompare("sw1", "SW1")).toBe(0)
    expect(["b", null, "A"].sort(naturalCompare)).toEqual([null, "A", "b"])
  })
})

describe("byNatural", () => {
  it("sorts objects by a label", () => {
    const rows = [{ name: "R10" }, { name: "R2" }, { name: "R1" }]
    expect(rows.sort(byNatural((r) => r.name)).map((r) => r.name)).toEqual([
      "R1",
      "R2",
      "R10",
    ])
  })
})

describe("compareValues", () => {
  it("sorts text naturally and numbers and dates by value", () => {
    expect(compareValues("disk2", "disk10")).toBeLessThan(0)
    expect(compareValues(10, 9)).toBeGreaterThan(0)
    expect(compareValues(3, 3)).toBe(0)
    expect(
      compareValues(new Date("2026-01-02"), new Date("2026-01-01"))
    ).toBeGreaterThan(0)
    expect(compareValues(new Date(5), new Date(5))).toBe(0)
  })

  it("puts empty text first", () => {
    expect(compareValues("", "a")).toBeLessThan(0)
    expect(compareValues(null, "a")).toBeLessThan(0)
  })
})
