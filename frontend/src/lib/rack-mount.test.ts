import { describe, expect, it } from "vitest"

import {
  earPositions,
  faceplateOffsetM,
  hasEars,
  EAR_PLATE_MM,
  earPlateM,
  isReversed,
  modelFrontM,
  modelShiftM,
  rackMountDraft,
  rackMountError,
  rackMountOf,
  rackMountPayload,
  rackMountSummary,
} from "./rack-mount"
import type { RackMountBlock } from "./rack-mount"

const BLOCK: RackMountBlock = {
  ears: true,
  positions: { front: 0, mid: 220, rear: 430 },
  default: "front",
  rails: "none",
}

describe("rackMountOf", () => {
  it("fits a device at its own position, else the type's default", () => {
    expect(rackMountOf(BLOCK, "mid")).toEqual({
      ears: true,
      position: "mid",
      offset_mm: 220,
      shift_mm: 220,
      rails: "none",
      reversed: false,
      ear_mm: EAR_PLATE_MM,
    })
    expect(rackMountOf(BLOCK).position).toBe("front")
    expect(
      rackMountOf({ ...BLOCK, positions: { mid: 200 }, default: "" }, "rear")
        .position
    ).toBe("mid")
  })

  it("reads an unrecorded type as front ears, flush", () => {
    expect(rackMountOf(null)).toMatchObject({ ears: true, offset_mm: 0 })
    expect(earPositions(null)).toEqual(["front"])
  })

  it("puts an earless device's faceplate on the rail", () => {
    const info = rackMountOf({
      ears: false,
      positions: {},
      default: "",
      rails: "sliding",
    })
    expect(hasEars(info)).toBe(false)
    expect(faceplateOffsetM(info)).toBe(0)
    expect(modelShiftM(info)).toBe(0)
  })

  it("moves a recessed type's model by the difference to its front fitting", () => {
    const recessed = { ...BLOCK, positions: { front: -40, rear: 300 } }
    const info = rackMountOf(recessed, "rear")
    expect(faceplateOffsetM(info)).toBeCloseTo(0.3)
    expect(modelShiftM(info)).toBeCloseTo(0.34)
    expect(faceplateOffsetM(rackMountOf(recessed))).toBeCloseTo(-0.04)
  })

  it("puts a fitted model's front on its ears or its faceplate, the further out", () => {
    // Plus the ear plate, whose back sits on the rail's face.
    const plate = EAR_PLATE_MM / 1000
    expect(modelFrontM(rackMountOf(BLOCK, "mid"))).toBeCloseTo(0.22 + plate, 4)
    expect(modelFrontM(rackMountOf(null))).toBeCloseTo(plate, 4)
    const recessed = { ...BLOCK, positions: { front: -40, rear: 300 } }
    expect(modelFrontM(rackMountOf(recessed))).toBeCloseTo(plate, 4)
    expect(modelFrontM(rackMountOf(recessed, "rear"))).toBeCloseTo(
      0.34 + plate,
      4
    )
    const bezel = { ...BLOCK, positions: { front: 25 } }
    expect(modelFrontM(rackMountOf(bezel))).toBeCloseTo(0.025 + plate, 4)
    expect(
      modelFrontM(rackMountOf({ ...BLOCK, ears: false, positions: {} }))
    ).toBe(0)
  })
})

describe("reversed and the ear plate", () => {
  const C9300 = { ...BLOCK, positions: { front: 0, mid: 98, reversed: 0 } }

  it("turns a reversed device round, its rear face on the ear plane", () => {
    const info = rackMountOf(C9300, "reversed")
    expect(info.position).toBe("reversed")
    expect(isReversed(info)).toBe(true)
    expect(info.shift_mm).toBe(0)
    expect(modelFrontM(info)).toBeCloseTo(EAR_PLATE_MM / 1000, 6)
    const out = rackMountOf({ ...C9300, positions: { reversed: 30 } })
    expect(modelFrontM(out)).toBeCloseTo(0.03 + EAR_PLATE_MM / 1000, 6)
    expect(isReversed(rackMountOf(C9300, "mid"))).toBe(false)
  })

  it("takes the type's ear plate, else the default", () => {
    expect(earPlateM(rackMountOf({ ...BLOCK, ear_mm: 4 }))).toBeCloseTo(0.004)
    expect(earPlateM(rackMountOf(BLOCK))).toBeCloseTo(EAR_PLATE_MM / 1000)
    expect(earPlateM(undefined)).toBeCloseTo(EAR_PLATE_MM / 1000)
    expect(rackMountError({ ...BLOCK, ear_mm: 20 })).toMatch(/Ear plate/)
    const draft = { ...rackMountDraft(C9300), ear_mm: "3" }
    expect(rackMountPayload(draft)).toEqual({ ...C9300, ear_mm: 3 })
    expect(rackMountSummary({ ...C9300, ear_mm: 3 })).toBe(
      "Front 0 mm (default) · Mid 98 mm · Reversed 0 mm, 3 mm ears"
    )
  })
})

describe("the form", () => {
  it("saves nothing for the default and a block otherwise", () => {
    expect(rackMountPayload(rackMountDraft(null))).toBeNull()
    expect(rackMountPayload(rackMountDraft(BLOCK))).toEqual(BLOCK)
    const earless = rackMountPayload({
      ...rackMountDraft(BLOCK),
      ears: false,
      rails: "sliding",
    })
    expect(earless).toEqual({
      ears: false,
      positions: {},
      default: "",
      rails: "sliding",
    })
  })

  it("says what's wrong before the API does", () => {
    expect(rackMountError(BLOCK)).toBeNull()
    expect(rackMountError({ ...BLOCK, positions: {} })).toMatch(/at least one/)
    expect(
      rackMountError({ ...BLOCK, positions: { mid: 1 }, default: "rear" })
    ).toMatch(/default/)
  })

  it("sums a type up in a line", () => {
    expect(rackMountSummary(BLOCK)).toBe(
      "Front 0 mm (default) · Mid 220 mm · Rear 430 mm"
    )
    expect(
      rackMountSummary({
        ears: false,
        positions: {},
        default: "",
        rails: "sliding",
      })
    ).toBe("No ears, sliding rails")
  })
})
