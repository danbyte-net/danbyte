import { describe, expect, it } from "vitest"

import {
  earPositions,
  faceplateOffsetM,
  hasEars,
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
    expect(modelFrontM(rackMountOf(BLOCK, "mid"))).toBeCloseTo(0.22)
    expect(modelFrontM(rackMountOf(null))).toBe(0)
    const recessed = { ...BLOCK, positions: { front: -40, rear: 300 } }
    expect(modelFrontM(rackMountOf(recessed))).toBe(0)
    expect(modelFrontM(rackMountOf(recessed, "rear"))).toBeCloseTo(0.34)
    const bezel = { ...BLOCK, positions: { front: 25 } }
    expect(modelFrontM(rackMountOf(bezel))).toBeCloseTo(0.025)
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
