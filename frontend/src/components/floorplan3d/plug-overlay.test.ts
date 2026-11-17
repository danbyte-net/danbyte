import { describe, expect, it, vi } from "vitest"

import { markerLifts } from "./device-model-port-markers"
import { PlugOverlayStore } from "./plug-overlay"

describe("plug overlay store", () => {
  it("publishes fronts and solid ports, and ignores a repeat", () => {
    const s = new PlugOverlayStore()
    const fn = vi.fn()
    s.subscribe(fn)
    s.setFronts(new Map([["Gi1/0/1", 0.012]]), true)
    expect(s.fronts.get("Gi1/0/1")).toBe(0.012)
    expect(s.ghost).toBe(true)
    s.setFronts(new Map([["Gi1/0/1", 0.012]]), true)
    expect(fn).toHaveBeenCalledTimes(1)
    const key = s.frontsKey
    s.setSolid(["Gi1/0/2", "Gi1/0/2"])
    expect([...s.solid]).toEqual(["Gi1/0/2"])
    // The solid ports leave the fronts' key alone.
    expect(s.frontsKey).toBe(key)
    s.setSolid(["Gi1/0/2"])
    expect(fn).toHaveBeenCalledTimes(2)
    s.setFronts(new Map(), false)
    expect(s.ghost).toBe(false)
    expect(s.fronts.size).toBe(0)
  })
})

describe("marker lifts", () => {
  const placed = [{ front: 0.012 }, { front: 0.02 }, {}]

  it("moves every wash to its part's front while the parts are ghosted", () => {
    expect(markerLifts(placed, true, null, null)).toEqual([0.012, 0.02, 0])
  })

  it("else only the hovered and selected ports'", () => {
    expect(markerLifts(placed, false, null, null)).toEqual([0, 0, 0])
    expect(markerLifts(placed, false, 1, null)).toEqual([0, 0.02, 0])
    expect(markerLifts(placed, false, null, 0)).toEqual([0.012, 0, 0])
  })
})
