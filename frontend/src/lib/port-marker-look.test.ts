import { describe, expect, it } from "vitest"

import { MODEL_PORT_SELECTED, MODEL_PORT_UNDEFINED } from "./model-ports"
import { MODEL_PORT_RESERVED, lighten, markerLook } from "./port-marker-look"

const TIER = "#3b82f6"

describe("markerLook", () => {
  it("washes a cabled or marked port in its state colour", () => {
    expect(markerLook({ id: "a", connected: true }, TIER)).toEqual({
      rim: TIER,
      fill: TIER,
    })
    expect(
      markerLook({ id: "a", connected: false, cable_state: "marked" }, TIER)
    ).toEqual({ rim: TIER, fill: TIER })
  })

  it("outlines a free port only, a held one in amber", () => {
    expect(markerLook({ id: "a", connected: false }, "#9ca3af")).toEqual({
      rim: "#9ca3af",
      fill: null,
    })
    expect(
      markerLook({ id: "a", connected: false, cable_state: "reserved" }, TIER)
    ).toEqual({ rim: MODEL_PORT_RESERVED, fill: null })
  })

  it("greys a marker with no port on the device", () => {
    expect(markerLook({ id: null }, TIER).rim).toBe(MODEL_PORT_UNDEFINED)
  })

  it("lightens the rim on hover and adds a wash", () => {
    const hover = markerLook({ id: "a", connected: false }, "#9ca3af", "hover")
    expect(hover.rim).toBe(lighten("#9ca3af", 0.45))
    expect(hover.rim).not.toBe("#9ca3af")
    expect(hover.fill).toBe("#9ca3af")
  })

  it("takes the selection colour when selected, whatever the state", () => {
    for (const p of [
      { id: "a", connected: true },
      { id: "a", connected: false, cable_state: "reserved" },
    ])
      expect(markerLook(p, TIER, "selected")).toEqual({
        rim: MODEL_PORT_SELECTED,
        fill: MODEL_PORT_SELECTED,
      })
  })
})

describe("lighten", () => {
  it("mixes toward white", () => {
    expect(lighten("#000000", 0.5)).toBe("#808080")
    expect(lighten("#ffffff", 0.3)).toBe("#ffffff")
    expect(lighten("not-a-colour", 0.5)).toBe("not-a-colour")
  })
})
