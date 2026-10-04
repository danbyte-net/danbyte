// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"

import {
  DEFAULT_PLATE_VIEW,
  defaultZoom,
  fitScale,
  stepZoom,
  storePlateView,
  storedPlateView,
  zoomLadder,
  zoomScale,
} from "./cabinet-plate-view"

// The cabinet plate's zoom is the rack's ladder of steps with "fit" - the
// plate as wide as its column, as it was drawn before it could zoom - as one
// stop among them, and the view is kept per browser.

const KEY = "danbyte.cabinetPlate.view"

afterEach(() => localStorage.clear())

describe("fitScale", () => {
  it("fits the column, no taller than 28rem", () => {
    // A 563 × 663 mm frame in a 530 px column: the height decides.
    expect(fitScale(530, { w: 563, h: 663 })).toBeCloseTo(448 / 663)
    // A wide, low one: the width does.
    expect(fitScale(530, { w: 1000, h: 300 })).toBeCloseTo(0.53)
  })
})

describe("zoomLadder", () => {
  it("puts fit among the steps", () => {
    expect(zoomLadder(0.676)).toEqual([
      0.45,
      0.6,
      "fit",
      0.8,
      1,
      1.3,
      1.6,
      2,
      2.5,
      3,
    ])
  })

  it("drops a step that close to fit", () => {
    expect(zoomLadder(0.995)).not.toContain(1)
    expect(zoomLadder(0.995)).toContain("fit")
  })
})

describe("stepZoom", () => {
  const fit = 0.676

  it("steps in and out from fit", () => {
    expect(stepZoom("fit", fit, 1)).toBe(0.8)
    expect(stepZoom("fit", fit, -1)).toBe(0.6)
  })

  it("comes back to fit on the way", () => {
    expect(stepZoom(0.6, fit, 1)).toBe("fit")
    expect(stepZoom(0.8, fit, -1)).toBe("fit")
  })

  it("stops at either end", () => {
    expect(stepZoom(0.45, fit, -1)).toBeNull()
    expect(stepZoom(3, fit, 1)).toBeNull()
    expect(stepZoom(2.5, fit, 1)).toBe(3)
  })

  it("passes a step fit has taken", () => {
    expect(stepZoom("fit", 0.995, 1)).toBe(1.3)
  })

  it("keeps a plate fitted above every step there", () => {
    expect(stepZoom("fit", 4, 1)).toBeNull()
    expect(stepZoom("fit", 4, -1)).toBe(3)
  })
})

describe("defaultZoom", () => {
  it("fits Names and Images, and draws Render larger", () => {
    expect(defaultZoom("names", 0.676)).toBe("fit")
    expect(defaultZoom("images", 0.676)).toBe("fit")
    expect(defaultZoom("render", 0.676)).toBe(1.3)
    // A small plate whose fit is larger already keeps it.
    expect(defaultZoom("render", 1.8)).toBe("fit")
    expect(zoomScale(defaultZoom("render", 1.8), 1.8)).toBe(1.8)
  })
})

describe("storedPlateView", () => {
  it("starts as Images, fitted, labelled", () => {
    expect(storedPlateView()).toEqual(DEFAULT_PLATE_VIEW)
    expect(DEFAULT_PLATE_VIEW).toEqual({
      mode: "images",
      zoom: "fit",
      labels: true,
    })
  })

  it("reads back what was stored", () => {
    storePlateView({ mode: "render", zoom: 1.6, labels: false })
    expect(JSON.parse(localStorage.getItem(KEY) ?? "")).toEqual({
      mode: "render",
      zoom: 1.6,
      labels: false,
    })
    expect(storedPlateView()).toEqual({
      mode: "render",
      zoom: 1.6,
      labels: false,
    })
  })

  it("reads anything it does not know as its default", () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ mode: "3d", zoom: 0.7, labels: "yes" })
    )
    expect(storedPlateView()).toEqual(DEFAULT_PLATE_VIEW)
    localStorage.setItem(KEY, "{not json")
    expect(storedPlateView()).toEqual(DEFAULT_PLATE_VIEW)
    localStorage.setItem(KEY, "null")
    expect(storedPlateView()).toEqual(DEFAULT_PLATE_VIEW)
  })
})
