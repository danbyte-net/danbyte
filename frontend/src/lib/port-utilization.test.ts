import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "vitest"

import { WITH_PORTS, invalidatePortCounts } from "./port-utilization"

describe("invalidatePortCounts", () => {
  it("marks the device and stack cards, the roll-up and rack port state stale, nothing else", () => {
    const qc = new QueryClient()
    const keys = [
      ["device-port-utilization", "d1"],
      ["vc-port-utilization", "vc1"],
      ["port-utilization-rollup"],
      ["rack-port-state", "r1"],
      ["device-interfaces", "d1"],
    ]
    for (const k of keys) qc.setQueryData(k, { ok: true })

    invalidatePortCounts(qc)

    const stale = (k: string[]) => qc.getQueryState(k)?.isInvalidated
    expect(stale(["device-port-utilization", "d1"])).toBe(true)
    expect(stale(["vc-port-utilization", "vc1"])).toBe(true)
    expect(stale(["port-utilization-rollup"])).toBe(true)
    expect(stale(["rack-port-state", "r1"])).toBe(true)
    expect(stale(["device-interfaces", "d1"])).toBe(false)
  })

  it("marks the racks' port figures stale, not the plain rack queries (#247)", () => {
    const qc = new QueryClient()
    const keys = [
      ["floor-plan-racks", "p1"],
      ["site-capacity", "s1"],
      ["rack", "r1", WITH_PORTS],
      ["racks", "", WITH_PORTS],
      ["rack", "r1"],
      ["racks", ""],
    ]
    for (const k of keys) qc.setQueryData(k, { ok: true })

    invalidatePortCounts(qc)

    const stale = (k: string[]) => qc.getQueryState(k)?.isInvalidated
    expect(stale(["floor-plan-racks", "p1"])).toBe(true)
    expect(stale(["site-capacity", "s1"])).toBe(true)
    expect(stale(["rack", "r1", WITH_PORTS])).toBe(true)
    expect(stale(["racks", "", WITH_PORTS])).toBe(true)
    expect(stale(["rack", "r1"])).toBe(false)
    expect(stale(["racks", ""])).toBe(false)
  })
})
