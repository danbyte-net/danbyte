import { describe, expect, it } from "vitest"

import {
  SPEED_TIERS,
  fmtKbps,
  fmtMbps,
  parseSpeedKbps,
  parseSpeedMbps,
  speedTier,
  speedTierOf,
} from "./speed"

describe("parseSpeedKbps", () => {
  it("turns a typed speed into whole kbps, and back through fmtKbps", () => {
    expect(parseSpeedKbps("500M")).toBe(500_000)
    expect(parseSpeedKbps("1G")).toBe(1_000_000)
    expect(parseSpeedKbps("2.5 Gbps")).toBe(2_500_000)
    // A bare number is kbps, as on the server.
    expect(parseSpeedKbps("64")).toBe(64)
    for (const typed of ["500M", "1G", "10G", "2.5G", "64k"])
      expect(fmtKbps(parseSpeedKbps(typed))).toBe(typed)
  })

  it("is null for nothing and undefined for what is not a speed", () => {
    expect(parseSpeedKbps("")).toBeNull()
    expect(parseSpeedKbps("  ")).toBeNull()
    expect(parseSpeedKbps(null)).toBeNull()
    expect(parseSpeedKbps("fast")).toBeUndefined()
    expect(parseSpeedKbps("0")).toBeUndefined()
    expect(parseSpeedKbps("0.0001k")).toBeUndefined()
  })
})

describe("parseSpeedMbps", () => {
  it("reads the shapes a speed is stored in", () => {
    expect(parseSpeedMbps("10G")).toBe(10_000)
    expect(parseSpeedMbps("2.5G")).toBe(2_500)
    expect(parseSpeedMbps("100M")).toBe(100)
    expect(parseSpeedMbps("1.6T")).toBe(1_600_000)
    // SNMP sync writes "1 Gbps"; operators type "100 Mbps".
    expect(parseSpeedMbps("1 Gbps")).toBe(1_000)
    expect(parseSpeedMbps("100 Mbps")).toBe(100)
    expect(parseSpeedMbps("10 Gbit/s")).toBe(10_000)
    expect(parseSpeedMbps("10Gb/s")).toBe(10_000)
    expect(parseSpeedMbps("10GbE")).toBe(10_000)
    expect(parseSpeedMbps("25ge")).toBe(25_000)
    expect(parseSpeedMbps("512k")).toBe(0.512)
    expect(parseSpeedMbps(" 40 G ")).toBe(40_000)
  })

  it("reads a bare integer as kbps, as the server does", () => {
    // api/speed.py: "1000000" is 1 Gbps, never 1 Tbps.
    expect(parseSpeedMbps("1000000")).toBe(1_000)
    expect(parseSpeedMbps("100000")).toBe(100)
    expect(parseSpeedMbps("1000")).toBe(1)
  })

  it("keeps a speed that a word follows, not an interface type", () => {
    expect(parseSpeedMbps("1G (auto)")).toBe(1_000)
    expect(parseSpeedMbps("10G-LR")).toBe(10_000)
    // A type name is not a speed: the faceplate falls back to the type.
    expect(parseSpeedMbps("25GBASE-SR")).toBeNull()
    expect(parseSpeedMbps("1000BASE-T")).toBeNull()
  })

  it("is null for anything else", () => {
    for (const v of [
      "",
      "  ",
      "auto",
      "fast",
      "10/100/1000",
      "G",
      null,
      undefined,
    ])
      expect(parseSpeedMbps(v)).toBeNull()
  })
})

describe("fmtKbps", () => {
  it("writes the server's short label (api/link_capacity.py short)", () => {
    expect(fmtKbps(10_000_000)).toBe("10G")
    expect(fmtKbps(500_000)).toBe("500M")
    expect(fmtKbps(2_500_000)).toBe("2.5G")
    expect(fmtKbps(1_544)).toBe("1.544M")
    expect(fmtKbps(64)).toBe("64k")
    expect(fmtKbps(100_000_000)).toBe("100G")
  })

  it("writes an asymmetric link as one pair", () => {
    expect(fmtKbps(100_000, { up: 20_000 })).toBe("100/20M")
    expect(fmtKbps(1_000_000, { up: 100_000 })).toBe("1G/100M")
    // The same both ways is one figure.
    expect(fmtKbps(100_000, { up: 100_000 })).toBe("100M")
    expect(fmtKbps(100_000, { up: null })).toBe("100M")
  })

  it("has a long form for details", () => {
    expect(fmtKbps(10_000_000, { long: true })).toBe("10 Gbps")
    expect(fmtKbps(1_544, { long: true })).toBe("1.544 Mbps")
    expect(fmtKbps(512, { long: true })).toBe("512 kbps")
    expect(fmtKbps(100_000, { long: true, up: 20_000 })).toBe("100/20 Mbps")
    expect(fmtKbps(1_000_000, { long: true, up: 100_000 })).toBe(
      "1 Gbps / 100 Mbps"
    )
  })

  it("is blank when unknown, never a guess", () => {
    for (const v of [null, undefined, 0, -5, Number.NaN])
      expect(fmtKbps(v)).toBe("")
  })
})

describe("fmtMbps", () => {
  it("formats an Mbps figure on the same scale", () => {
    expect(fmtMbps(10_000)).toBe("10G")
    expect(fmtMbps(2_500, { long: true })).toBe("2.5 Gbps")
    expect(fmtMbps(100, { long: true })).toBe("100 Mbps")
    expect(fmtMbps(0.5)).toBe("500k")
    expect(fmtMbps(100, { up: 20 })).toBe("100/20M")
    expect(fmtMbps(0)).toBe("")
    expect(fmtMbps(Number("not a number"))).toBe("")
  })
})

describe("the speed scale", () => {
  it("splits sub-1G at 100M and names the lowest tier for what it holds", () => {
    expect(SPEED_TIERS.map((t) => t.label)).toEqual([
      "<100M",
      "100M",
      "1G",
      "2.5G",
      "10G",
      "25G",
      "40G",
      "100G",
      "200G",
      "400G+",
    ])
    expect(speedTier(10).label).toBe("<100M")
    expect(speedTier(50).label).toBe("<100M")
    expect(speedTier(100).label).toBe("100M")
    expect(speedTier(500).label).toBe("100M")
    expect(speedTier(999).label).toBe("100M")
    expect(speedTier(1_000).label).toBe("1G")
    expect(speedTier(5_000).label).toBe("2.5G")
    expect(speedTier(50_000).label).toBe("40G")
    expect(speedTier(1_600_000).label).toBe("400G+")
  })

  it("rises in order with one colour per tier", () => {
    for (let i = 1; i < SPEED_TIERS.length; i++)
      expect(SPEED_TIERS[i].minMbps).toBeGreaterThan(SPEED_TIERS[i - 1].minMbps)
    expect(new Set(SPEED_TIERS.map((t) => t.hex)).size).toBe(SPEED_TIERS.length)
  })

  it("keeps the colours the faceplates have always shown from 100M up", () => {
    const hex = (label: string) =>
      SPEED_TIERS.find((t) => t.label === label)?.hex
    expect(hex("100M")).toBe("#f59e0b") // the old sub-1G amber
    expect(hex("1G")).toBe("#10b981")
    expect(hex("10G")).toBe("#0ea5e9")
    expect(hex("100G")).toBe("#8b5cf6")
    expect(hex("400G+")).toBe("#d946ef")
  })

  it("tiers a speed as text", () => {
    expect(speedTierOf("10G")?.label).toBe("10G")
    expect(speedTierOf("100 Mbps")?.label).toBe("100M")
    expect(speedTierOf("1000000")?.label).toBe("1G")
    expect(speedTierOf("auto")).toBeNull()
    expect(speedTierOf(null)).toBeNull()
  })
})
