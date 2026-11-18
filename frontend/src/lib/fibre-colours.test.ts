import { describe, expect, it } from "vitest"

import {
  FIBRE_COLOURS as C,
  NEUTRAL,
  copperColor,
  endBandColor,
  endColours,
  fibreColor,
  fibreGrade,
  isApc,
  lcBodyColor,
  recolourChannel,
} from "./fibre-colours"

describe("fibre colours", () => {
  it("reads the grade from the cable type", () => {
    expect(
      ["smf", "smf-os1", "smf-os2", "mmf", "mmf-om1", "mmf-om2"].map(fibreGrade)
    ).toEqual(["os", "os", "os", "om12", "om12", "om12"])
    expect(["mmf-om3", "mmf-om4", "mmf-om5", "aoc"].map(fibreGrade)).toEqual([
      "om34",
      "om34",
      "om5",
      "om34",
    ])
    expect(["cat6", "dac-passive", "power", "", null].map(fibreGrade)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ])
  })

  it("colours the jacket from the cable, else by type", () => {
    expect(fibreColor("#FF0000", "smf-os2")).toBe("#ff0000")
    expect(fibreColor(null, "smf-os2")).toBe(C.yellow)
    expect(fibreColor("", "mmf-om2")).toBe(C.orange)
    expect(fibreColor(null, "mmf-om4")).toBe(C.aqua)
    expect(fibreColor(null, "mmf-om5")).toBe(C.lime)
    expect(fibreColor("red", "")).toBe(NEUTRAL)
  })

  it("colours LC bodies by type and polish", () => {
    expect(lcBodyColor("smf-os2", false)).toBe(C.blue)
    expect(lcBodyColor("smf-os2", true)).toBe(C.green)
    expect(lcBodyColor("mmf-om1", false)).toBe(C.beige)
    expect(lcBodyColor("mmf-om3", false)).toBe(C.aqua)
    expect(lcBodyColor("mmf-om5", false)).toBe(C.lime)
    expect(lcBodyColor("", true)).toBe(C.green)
    expect(lcBodyColor("", false)).toBe(NEUTRAL)
  })

  it("tells APC from the port type or connector", () => {
    expect(isApc("lc-apc-duplex")).toBe(true)
    expect(isApc("10gbase-x-sfpp", "lc-apc")).toBe(true)
    expect(isApc("lc-duplex", "lc")).toBe(false)
    expect(isApc(undefined, null)).toBe(false)
    expect(isApc("capc")).toBe(false)
  })

  it("maps materials to channels and an end to its colours", () => {
    expect(
      ["CABLE", "FIBRE", "LC_BODY", "END_BAND", "Metal"].map(recolourChannel)
    ).toEqual(["cable", "fibre", "lc", "band", null])
    expect(copperColor(null)).toBe(NEUTRAL)
    expect(
      endColours({ color: null, cableType: "smf-os2", apc: true })
    ).toEqual({ cable: NEUTRAL, fibre: C.yellow, lc: C.green, band: NEUTRAL })
    expect(
      endColours({ color: null, cableType: "", apc: false, end: "a" }).band
    ).toBe(C.yellow)
    expect(endBandColor("b")).toBe(C.green)
    expect(endBandColor(null)).toBe(NEUTRAL)
  })
})
