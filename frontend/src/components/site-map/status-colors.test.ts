import { describe, expect, it } from "vitest"

import { markerZ, worstCheck } from "./status-colors"

describe("markerZ", () => {
  it("selected always beats everything unselected", () => {
    const selectedDevice = markerZ("device", "up", true)
    const downSite = markerZ("site", "down")
    expect(selectedDevice).toBeGreaterThan(downSite)
  })

  it("problems surface above healthy neighbours across kinds", () => {
    // A down device must ride above a healthy site - the whole point of the
    // rework: the thing that needs attention is the thing you can click.
    expect(markerZ("device", "down")).toBeGreaterThan(markerZ("site", "up"))
    expect(markerZ("device", "degraded")).toBeGreaterThan(markerZ("site", "up"))
  })

  it("within a health band: sites > free markers > devices", () => {
    expect(markerZ("site", "up")).toBeGreaterThan(markerZ("marker", null))
    expect(markerZ("marker", null)).toBeGreaterThan(markerZ("device", "up"))
    expect(markerZ("site", "down")).toBeGreaterThan(markerZ("device", "down"))
  })

  it("stale/unknown/null rank as healthy, not as problems", () => {
    expect(markerZ("device", "stale")).toBe(markerZ("device", "up"))
    expect(markerZ("device", null)).toBe(markerZ("device", "unknown"))
  })
})

describe("worstCheck", () => {
  it("picks the worst across the severity order", () => {
    expect(worstCheck(["up", "degraded", "down"])).toBe("down")
    expect(worstCheck(["up", "degraded"])).toBe("degraded")
    expect(worstCheck(["up", "stale"])).toBe("stale")
    expect(worstCheck(["up", "up"])).toBe("up")
  })

  it("ignores empties and returns null when nothing has a status", () => {
    expect(worstCheck([])).toBeNull()
    expect(worstCheck([null, undefined])).toBeNull()
    expect(worstCheck([null, "up"])).toBe("up")
  })

  it("treats unknown strings like stale", () => {
    expect(worstCheck(["up", "weird"])).toBe("weird")
    expect(worstCheck(["down", "weird"])).toBe("down")
  })
})
