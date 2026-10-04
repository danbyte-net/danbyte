import { describe, expect, it } from "vitest"

import type { ImagePorts } from "@/lib/api"
import {
  GUIDE_STEP,
  GUIDE_STEP_COARSE,
  MIN_GUIDE_GAP,
  cabinetPhotoBox,
  defaultRail,
  displayScale,
  draftCalibration,
  draftOf,
  effectiveFrontCal,
  fmtPhotoSize,
  hasSavedSize,
  moveGuide,
  newDraft,
  nudgeGuide,
  parseSpan,
  photoDocToSave,
  photoHeightMm,
  photoWidthMm,
  resolveCalibration,
  withCalibration,
  withScale,
  withoutCalibrations,
} from "./photo-calibration"

// Photo calibration (#277): two guides at fractions of a photo's width with
// the real distance between them give its true width; the rail line, a
// fraction of its height, says where the DIN rail runs. The editor moves the
// guides, the document keeps them per side, the cabinet drawing places the
// photo by them.

const CAL = { left: 0.1, right: 0.9, span_mm: 48, rail: 0.55 }
const XC206 = { width_mm: 60, height_mm: 147, din_rail_mm: null }
const marker = { kind: "interface", name: "P1", x: 0.5, y: 0.1, w: 0.1, h: 0.1 }

describe("true size", () => {
  it("is the distance between the guides over their share of the photo", () => {
    expect(photoWidthMm(CAL)).toBe(60)
    expect(photoWidthMm({ left: 0, right: 1, span_mm: 60 })).toBe(60)
    // A 163 × 398 px photo 60 mm wide.
    expect(photoHeightMm(60, 398 / 163)).toBeCloseTo(146.5, 1)
  })

  it("reads as the editor writes it", () => {
    expect(fmtPhotoSize(92.44, 108)).toBe("Photo 92.4 × 108.0 mm")
  })
})

describe("resolveCalibration", () => {
  it("adds the photo's true width, as the server does", () => {
    expect(resolveCalibration(CAL)).toEqual({ ...CAL, photo_mm: 60 })
    // The server's photo_mm, when it sent one, stands.
    expect(resolveCalibration({ ...CAL, photo_mm: 60.1 })?.photo_mm).toBe(60.1)
  })

  it("takes the photo's edges for missing guides and no rail line", () => {
    expect(resolveCalibration({ span_mm: 120 })).toEqual({
      left: 0,
      right: 1,
      span_mm: 120,
      rail: null,
      photo_mm: 120,
    })
  })

  it("refuses what the server would not read", () => {
    for (const raw of [
      null,
      "wide",
      { left: 0.1, right: 0.9 },
      { left: 0.5, right: 0.5, span_mm: 10 },
      { left: 0.9, right: 0.1, span_mm: 10 },
      { left: "0", right: 1, span_mm: 10 },
    ])
      expect(resolveCalibration(raw)).toBeNull()
  })
})

describe("effectiveFrontCal", () => {
  const typeCal = { ...CAL, photo_mm: 60 }
  it("takes the device's own calibration over its type's", () => {
    const own: ImagePorts = {
      front: [],
      rear: [],
      view: { front: { cal: { ...CAL, span_mm: 24 } } },
    }
    expect(
      effectiveFrontCal({
        image_ports: own,
        device_type: { front_cal: typeCal },
      })?.photo_mm
    ).toBe(30)
  })

  it("inherits the type's without one - an override without a calibration too", () => {
    const override: ImagePorts = { front: [marker], rear: [] }
    for (const image_ports of [null, undefined, override])
      expect(
        effectiveFrontCal({ image_ports, device_type: { front_cal: typeCal } })
      ).toEqual(typeCal)
    expect(
      effectiveFrontCal({ image_ports: null, device_type: { front_cal: null } })
    ).toBeNull()
    expect(effectiveFrontCal({ device_type: null })).toBeNull()
  })
})

describe("moving the guides", () => {
  const g = { left: 0, right: 1, rail: 0.5 }

  it("keeps them on the photo", () => {
    expect(moveGuide(g, "left", -0.2).left).toBe(0)
    expect(moveGuide(g, "right", 1.3).right).toBe(1)
    expect(moveGuide(g, "rail", 1.5).rail).toBe(1)
    expect(moveGuide(g, "rail", -1).rail).toBe(0)
  })

  it("keeps the two across it apart, left before right", () => {
    const close = moveGuide({ ...g, right: 0.5 }, "left", 0.9)
    expect(close.right - close.left).toBeGreaterThanOrEqual(MIN_GUIDE_GAP)
    expect(close.left).toBeLessThan(0.5)
    const back = moveGuide({ ...g, left: 0.68 }, "right", 0.1)
    // Never a hair under the server's minimum in floating point.
    expect(back.right - back.left).toBeGreaterThanOrEqual(MIN_GUIDE_GAP)
  })

  it("rounds to four decimals and leaves the rest of the draft alone", () => {
    const d = { ...newDraft(XC206), span: "60" }
    expect(moveGuide(d, "left", 0.123456)).toEqual({ ...d, left: 0.1235 })
  })

  it("nudges by the markers' steps, Shift coarser", () => {
    expect(nudgeGuide(g, "left", 1).left).toBe(GUIDE_STEP)
    expect(nudgeGuide(g, "right", -1, true).right).toBe(1 - GUIDE_STEP_COARSE)
    expect(nudgeGuide(g, "rail", 1).rail).toBe(0.5 + GUIDE_STEP)
    // At an edge it stays there.
    expect(nudgeGuide(g, "left", -1).left).toBe(0)
  })
})

describe("the editor's draft", () => {
  it("starts on the photo's edges with the type's width between them", () => {
    expect(newDraft(XC206)).toEqual({
      left: 0,
      right: 1,
      rail: 0.5,
      span: "60",
    })
    // Without a width there is nothing to fill in.
    expect(newDraft({ ...XC206, width_mm: null }).span).toBe("")
  })

  it("puts the rail line at the type's rail position", () => {
    expect(defaultRail({ ...XC206, din_rail_mm: 49 })).toBe(0.3333)
    expect(defaultRail({ ...XC206, height_mm: null, din_rail_mm: 49 })).toBe(
      0.5
    )
    expect(
      draftOf({ ...CAL, rail: null }, { ...XC206, din_rail_mm: 49 })
    ).toEqual({ left: 0.1, right: 0.9, rail: 0.3333, span: "48" })
  })

  it("saves only a distance from 1 to 5000 mm", () => {
    expect(parseSpan(" 58.5 ")).toBe(58.5)
    for (const t of ["", "0", "0.5", "5001", "abc"])
      expect(parseSpan(t)).toBeNull()
    expect(draftCalibration(draftOf(CAL, XC206))).toEqual(CAL)
    expect(draftCalibration({ ...draftOf(CAL, XC206), span: "" })).toBeNull()
  })
})

describe("the photo document", () => {
  const doc: ImagePorts = {
    front: [marker],
    rear: [],
    view: { front: { scale: 0.3 } },
  }

  it("sets a calibration beside the saved size, and clears it again", () => {
    const cal = withCalibration(doc, "front", CAL)
    expect(cal).toEqual({
      front: [marker],
      rear: [],
      view: { front: { scale: 0.3, cal: CAL } },
    })
    expect(withCalibration(cal, "front", null)).toEqual(doc)
  })

  it("drops a side's view, and the view, once nothing is left in them", () => {
    const only = withCalibration({ front: [], rear: [] }, "rear", CAL)
    expect(only.view).toEqual({ rear: { cal: CAL } })
    expect(withCalibration(only, "rear", null)).toEqual({ front: [], rear: [] })
    expect(withoutCalibrations(withCalibration(doc, "front", CAL))).toEqual(doc)
  })

  it("sets and removes the saved size, keeping the calibration", () => {
    const cal = withCalibration({ front: [], rear: [] }, "front", CAL)
    // Fit is a saved size too: null.
    expect(withScale(cal, "front", null).view?.front).toEqual({
      cal: CAL,
      scale: null,
    })
    expect(hasSavedSize(withScale(cal, "front", null), "front")).toBe(true)
    expect(withScale(withScale(cal, "front", 2), "front", undefined)).toEqual(
      cal
    )
    // A view holding only a calibration is no saved size.
    expect(hasSavedSize(cal, "front")).toBe(false)
  })

  it("draws at its saved size, else at its upload size", () => {
    expect(displayScale({ scale: 0.3, cal: CAL })).toBe(0.3)
    // Fit.
    expect(displayScale({ scale: null })).toBeNull()
    // A calibration alone - or the empty side a replaced photo leaves - is
    // no size: the upload size, not Fit.
    expect(displayScale({ cal: CAL })).toBe(1)
    expect(displayScale({})).toBe(1)
    expect(displayScale(undefined)).toBe(1)
  })

  it("is saved while it holds markers, a size or a calibration", () => {
    expect(photoDocToSave(doc)).toBe(doc)
    const sized: ImagePorts = {
      front: [],
      rear: [],
      view: { rear: { scale: null } },
    }
    expect(photoDocToSave(sized)).toBe(sized)
    const cal = withCalibration({ front: [], rear: [] }, "front", CAL)
    expect(photoDocToSave(cal)).toBe(cal)
    // Nothing left: null clears it.
    expect(photoDocToSave({ front: [], rear: [] })).toBeNull()
    expect(
      photoDocToSave({ front: [], rear: [], view: { front: {} } })
    ).toBeNull()
  })
})

describe("cabinetPhotoBox", () => {
  const body = { x: 210, y: 1.5 }
  const cal = { left: 0.1, rail: 0.55, photo_mm: 60 }

  it("puts the left guide on the body's left edge and the rail line on the rail", () => {
    // 60 mm wide, 147 mm tall; the rail's centreline at 75 mm.
    const box = cabinetPhotoBox(body, cal, 2.45, 75)
    expect(box).toEqual({ x: 204, y: -5.85, width: 60, height: 147 })
    // The guide: 0.1 of the photo in from its left edge.
    expect(box.x + cal.left * box.width).toBe(body.x)
    // The rail line: 0.55 of the photo down from its top.
    expect(box.y + cal.rail * box.height).toBeCloseTo(75, 6)
  })

  it("hangs a photo without a rail line from the body's top", () => {
    expect(cabinetPhotoBox(body, { ...cal, rail: null }, 2, 75)).toEqual({
      x: 204,
      y: 1.5,
      width: 60,
      height: 120,
    })
  })
})
