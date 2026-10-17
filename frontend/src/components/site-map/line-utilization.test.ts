import { describe, expect, it } from "vitest"

import type { SiteMapLink } from "@/lib/api"

import {
  UTIL_BANDS,
  UTIL_NO_DATA,
  directionLabel,
  fmtBps,
  halfLook,
  lineInterfaceIds,
  lineUtilization,
  splitAtMidpoint,
  utilBand,
} from "./line-utilization"
import type { LiveRate } from "./line-utilization"

const end = (
  id: string | null,
  speed_kbps: number | null = null,
  kind = "interface"
): SiteMapLink["a"] => ({
  site_id: "s",
  device: { id: `d-${id}`, name: `d-${id}` },
  port: id ? { id, name: id, kind, speed_kbps } : null,
  restricted: false,
})

const link = (a: SiteMapLink["a"], z: SiteMapLink["z"]): SiteMapLink => ({
  a,
  z,
  capacity: null,
  cable_id: null,
})

const rate = (
  in_bps: number | null,
  out_bps: number | null,
  speed_mbps: number | null = 1000,
  at = "2026-10-10T10:00:00Z"
): LiveRate => ({ in_bps, out_bps, speed_mbps, at, interval_s: 300 })

describe("bands", () => {
  it("cuts at 10, 25, 50, 75 and 90 %", () => {
    expect(UTIL_BANDS.map((b) => b.label)).toEqual([
      "< 10%",
      "10–25%",
      "25–50%",
      "50–75%",
      "75–90%",
      "≥ 90%",
    ])
    expect(utilBand(9.9).key).toBe("lt10")
    expect(utilBand(10).key).toBe("10-25")
    expect(utilBand(25).key).toBe("25-50")
    expect(utilBand(74.9).key).toBe("50-75")
    expect(utilBand(89.9).key).toBe("75-90")
    expect(utilBand(90).key).toBe("ge90")
    expect(utilBand(140).key).toBe("ge90")
  })

  it("draws a busier half wider, and no data grey", () => {
    expect(halfLook({ bps: 1, pct: 95 }).weight).toBeGreaterThan(
      halfLook({ bps: 1, pct: 5 }).weight
    )
    expect(halfLook(null)).toEqual({
      color: UTIL_NO_DATA.hex,
      weight: UTIL_NO_DATA.weight,
    })
    expect(halfLook({ bps: 5, pct: null }).color).toBe(UTIL_NO_DATA.hex)
  })
})

describe("lineUtilization", () => {
  const line = {
    id: "l1",
    capacity: { kbps: 1_000_000 },
    links: [link(end("a1"), end("z1"))],
  }

  it("gives the half at A what leaves A, and the half at Z what leaves Z", () => {
    const u = lineUtilization(line, {
      a1: rate(100e6, 420e6),
      z1: rate(420e6, 100e6),
    })
    expect(u.az).toEqual({ bps: 420e6, pct: 42 })
    expect(u.za).toEqual({ bps: 100e6, pct: 10 })
    expect(u.at).toBe("2026-10-10T10:00:00Z")
  })

  it("reads the far end when the near end has no rate", () => {
    const u = lineUtilization(line, { z1: rate(300e6, 50e6) })
    expect(u.az?.bps).toBe(300e6)
    expect(u.za?.bps).toBe(50e6)
  })

  it("is no data without rates", () => {
    const u = lineUtilization(line, {})
    expect(u.az).toBeNull()
    expect(u.za).toBeNull()
  })

  it("adds up a bundle's links against the line's capacity", () => {
    const bundle = {
      id: "b",
      capacity: { kbps: 2_000_000 },
      links: [link(end("a1"), end("z1")), link(end("a2"), end("z2"))],
    }
    const u = lineUtilization(bundle, {
      a1: rate(0, 500e6),
      a2: rate(0, 500e6),
    })
    expect(u.az).toEqual({ bps: 1e9, pct: 50 })
  })

  it("falls back to the ports' speed without a line capacity", () => {
    const bare = { id: "c", links: [link(end("a1", 100_000), end("z1"))] }
    // The live speed (1000 Mbit/s) wins over the stored 100M.
    expect(lineUtilization(bare, { a1: rate(0, 250e6) }).az?.pct).toBe(25)
    expect(lineUtilization(bare, { a1: rate(0, 25e6, null) }).az?.pct).toBe(25)
  })

  it("keeps the rate when nothing gives a capacity", () => {
    const bare = { id: "c", links: [link(end("a1"), end("z1"))] }
    const u = lineUtilization(bare, { a1: rate(0, 5e6, null) })
    expect(u.az).toEqual({ bps: 5e6, pct: null })
    expect(directionLabel(u.az)).toBe("5 Mbps")
  })

  it("ignores ends that are not device interfaces or are restricted", () => {
    const vm = link(end("v1", null, "vm_interface"), {
      ...end("z9"),
      restricted: true,
    })
    expect(lineInterfaceIds([{ id: "t", links: [vm] }])).toEqual([])
    expect(lineInterfaceIds([line, line])).toEqual(["a1", "z1"])
  })
})

describe("labels and geometry", () => {
  it("labels a direction", () => {
    expect(directionLabel(null)).toBe("No data")
    expect(directionLabel({ bps: 1, pct: 0.2 })).toBe("< 1%")
    expect(directionLabel({ bps: 1, pct: 41.6 })).toBe("42%")
    expect(fmtBps(850)).toBe("850 bps")
    expect(fmtBps(12_400_000)).toBe("12.4 Mbps")
  })

  it("splits a path at its halfway point", () => {
    const [a, z] = splitAtMidpoint([
      [0, 0],
      [0, 1],
      [0, 3],
    ])
    expect(a[0]).toEqual([0, 0])
    expect(a[a.length - 1]).toEqual(z[0])
    expect(z[0][1]).toBeCloseTo(1.5)
    expect(z[z.length - 1]).toEqual([0, 3])
  })
})
