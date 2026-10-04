import { describe, expect, it } from "vitest"

import {
  fmtUnits,
  placeInRack,
  rackClash,
  unitBlocker,
  unitRange,
  unitRow,
} from "./rack-placement"
import type { RackMount, RackOccupant } from "./rack-placement"

// The device form's rack elevation draws the device being placed red where
// DeviceSerializer.validate would refuse it, and says why in its words. The
// rules are the server's: faces collide only when they match or one is
// blank, and half-width devices share a unit from opposite halves.

const RACK = { u_height: 42, starting_unit: 1, desc_units: false }

const dev = (
  name: string,
  position: number | null,
  patch: Partial<RackOccupant> = {}
): RackOccupant => ({
  id: name,
  name,
  position,
  face: "front",
  rack_width: "full",
  rack_side: "",
  u_height: 1,
  ...patch,
})

const FULL: RackMount = { face: "front", width: "full", side: "" }

describe("units", () => {
  it("spans the rack from its starting unit", () => {
    expect(unitRange(RACK)).toEqual([1, 42])
    expect(unitRange({ ...RACK, starting_unit: 0 })).toEqual([0, 41])
  })

  it("puts the highest unit in the top row, or the lowest when numbered down", () => {
    expect(unitRow(RACK, 42)).toBe(1)
    expect(unitRow(RACK, 1)).toBe(42)
    expect(unitRow({ ...RACK, desc_units: true }, 1)).toBe(1)
    expect(unitRow({ ...RACK, desc_units: true }, 42)).toBe(42)
  })

  it("labels a device's units as the Position dropdown does", () => {
    expect(fmtUnits(21, 1)).toBe("U21")
    expect(fmtUnits(21, 2)).toBe("U21–U22")
  })
})

describe("unitBlocker", () => {
  const sw = dev("sw-1", 10, { u_height: 2 })

  it("finds the device in the unit on the same face", () => {
    expect(unitBlocker([sw], FULL, 11)?.name).toBe("sw-1")
    expect(unitBlocker([sw], FULL, 12)).toBeUndefined()
  })

  it("lets different faces share a unit, and a blank face collide with both", () => {
    expect(unitBlocker([sw], { ...FULL, face: "rear" }, 10)).toBeUndefined()
    expect(unitBlocker([sw], { ...FULL, face: "" }, 10)?.name).toBe("sw-1")
    const blank = dev("pdu-1", 20, { face: "" })
    expect(unitBlocker([blank], { ...FULL, face: "rear" }, 20)?.name).toBe(
      "pdu-1"
    )
  })

  it("ignores a full-depth device on the other face, as the server does", () => {
    // The elevation draws it hatched there; the serializer lets it pass.
    expect(unitBlocker([sw], { ...FULL, face: "rear" }, 11)).toBeUndefined()
  })

  it("lets half-width devices share a unit from opposite halves", () => {
    const left = dev("tor-a", 5, { rack_width: "half", rack_side: "left" })
    const half: RackMount = { face: "front", width: "half", side: "right" }
    expect(unitBlocker([left], half, 5)).toBeUndefined()
    expect(unitBlocker([left], { ...half, side: "left" }, 5)?.name).toBe(
      "tor-a"
    )
    // A full-width device takes the whole unit.
    expect(unitBlocker([left], FULL, 5)?.name).toBe("tor-a")
  })

  it("leaves out the device being placed, and devices not in a unit", () => {
    expect(unitBlocker([sw], FULL, 10, "sw-1")).toBeUndefined()
    expect(unitBlocker([dev("loose", null)], FULL, 1)).toBeUndefined()
  })
})

describe("rackClash", () => {
  const devices = [dev("b-sw", 10), dev("a-srv", 11, { u_height: 2 })]

  it("passes a device that fits", () => {
    expect(
      rackClash(RACK, devices, { ...FULL, position: 13, height: 2 })
    ).toBeNull()
  })

  it("names the first device the server meets, and the units that collide", () => {
    // The API lists devices by name, as the server walks them.
    expect(
      rackClash(RACK, [devices[1], devices[0]], {
        ...FULL,
        position: 9,
        height: 3,
      })
    ).toEqual({ message: "Overlaps a-srv at U11.", units: [10, 11] })
  })

  it("refuses a device that runs past the rack, in the server's words", () => {
    expect(rackClash(RACK, [], { ...FULL, position: 42, height: 2 })).toEqual({
      message: "Device doesn't fit at U42 in a 42U rack.",
      units: [],
    })
  })
})

describe("placeInRack", () => {
  const devices = [dev("sw-1", 10), dev("sw-2", 14)]
  const twoU = { ...FULL, height: 2 }

  it("makes the clicked unit the device's lowest", () => {
    expect(placeInRack(RACK, devices, twoU, 11)).toEqual({ position: 11 })
  })

  it("moves it down as little as the free run needs", () => {
    // 11-13 is free: a 2U device clicked at 13 sits at 12-13.
    expect(placeInRack(RACK, devices, twoU, 13)).toEqual({ position: 12 })
    expect(placeInRack(RACK, [], twoU, 42)).toEqual({ position: 41 })
  })

  it("refuses a taken unit, naming the device in it", () => {
    expect(placeInRack(RACK, devices, twoU, 10)).toEqual({
      blocker: devices[0],
    })
  })

  it("refuses a run shorter than the device, saying how long it is", () => {
    const tight = [dev("sw-1", 10), dev("sw-2", 12)]
    expect(placeInRack(RACK, tight, twoU, 11)).toEqual({ free: 1 })
  })

  it("counts only what collides on the face clicked", () => {
    // Front-mounted sw-1 leaves the rear of U10 free.
    expect(placeInRack(RACK, devices, { ...twoU, face: "rear" }, 10)).toEqual({
      position: 10,
    })
  })
})
