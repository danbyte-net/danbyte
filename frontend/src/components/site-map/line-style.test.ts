import { describe, expect, it } from "vitest"

import { SPEED_TIERS, speedTier } from "@/lib/speed"
import {
  isLineColorBy,
  KIND_COLOR,
  lineColor,
  lineKey,
  NO_VALUE_HEX,
} from "./line-style"
import type { LineLook } from "./line-style"

// Color by on the site map (#246): Type keeps the look the map always had,
// Status wears the line's status colour, Speed the tier of its capacity on
// the shared scale - and a line the mode can say nothing about is zinc,
// never a guess.

const ACTIVE = { name: "Active", color: "#10b981" }
const PLANNED = { name: "Planned", color: "#f59e0b" }
const G10 = { kbps: 10_000_000 }

describe("lineColor", () => {
  it("Type: the line's own colour, else its kind's", () => {
    expect(lineColor({ kind: "circuit", color: "#123456" }, "type")).toBe(
      "#123456"
    )
    expect(lineColor({ kind: "circuit", color: "" }, "type")).toBe(
      KIND_COLOR.circuit
    )
    expect(lineColor({ kind: "tunnel" }, "type")).toBe(KIND_COLOR.tunnel)
    // A bare hex from the catalog still draws.
    expect(lineColor({ kind: "tunnel", color: "abcdef" }, "type")).toBe(
      "#abcdef"
    )
  })

  it("Type: a cable with no colour of its own is the legend's amber", () => {
    expect(lineColor({ kind: "cable", color: "" }, "type")).toBe("#f59e0b")
    expect(KIND_COLOR.cable).toBe("#f59e0b")
  })

  it("Status: the status colour, zinc without one", () => {
    const line: LineLook = { kind: "cable", color: "#ff0000", status: ACTIVE }
    expect(lineColor(line, "status")).toBe(ACTIVE.color)
    expect(lineColor({ kind: "circuit", status: null }, "status")).toBe(
      NO_VALUE_HEX
    )
  })

  it("Speed: the capacity's tier on the shared scale, zinc when unknown", () => {
    expect(lineColor({ kind: "circuit", capacity: G10 }, "speed")).toBe(
      speedTier(10_000).hex
    )
    // A 100G commit and a 500M one look apart.
    expect(
      lineColor({ kind: "circuit", capacity: { kbps: 100_000_000 } }, "speed")
    ).toBe(speedTier(100_000).hex)
    expect(
      lineColor({ kind: "circuit", capacity: { kbps: 500_000 } }, "speed")
    ).toBe(speedTier(500).hex)
    expect(lineColor({ kind: "tunnel", capacity: null }, "speed")).toBe(
      NO_VALUE_HEX
    )
    expect(lineColor({ kind: "cable" }, "speed")).toBe(NO_VALUE_HEX)
  })
})

describe("lineKey", () => {
  it("keys only what the lines carry, statuses by name, tiers slow to fast", () => {
    const key = lineKey([
      { kind: "circuit", status: PLANNED, capacity: { kbps: 100_000_000 } },
      { kind: "cable", status: ACTIVE, capacity: G10 },
      { kind: "cable", status: ACTIVE, capacity: G10 },
      { kind: "tunnel", status: null, capacity: null },
    ])
    expect(key.statuses).toEqual([ACTIVE, PLANNED])
    expect(key.noStatus).toBe(true)
    expect(key.tiers.map((t) => t.label)).toEqual(["10G", "100G"])
    expect(key.unknown).toBe(true)
  })

  it("says nothing is missing when every line has both", () => {
    const key = lineKey([{ kind: "cable", status: ACTIVE, capacity: G10 }])
    expect(key.noStatus).toBe(false)
    expect(key.unknown).toBe(false)
    expect(key.tiers).toEqual([SPEED_TIERS.find((t) => t.label === "10G")])
  })

  it("is empty for no lines", () => {
    expect(lineKey([])).toEqual({
      statuses: [],
      noStatus: false,
      tiers: [],
      unknown: false,
    })
  })
})

describe("isLineColorBy", () => {
  it("accepts the three modes only", () => {
    for (const v of ["type", "status", "speed"])
      expect(isLineColorBy(v)).toBe(true)
    for (const v of ["cable", "", null, undefined, "Speed"])
      expect(isLineColorBy(v)).toBe(false)
  })
})
