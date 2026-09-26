import { describe, expect, it } from "vitest"

import { approxMeasure, baselineAt, fit, measureText } from "./measure"

// Card sizes come from these widths, so they must be deterministic where
// there is no canvas (tests, SSR) and never clip Inter.

describe("approxMeasure", () => {
  it("reads Inter's advance widths", () => {
    // "M" is 1850 units of 2048 at regular weight.
    expect(approxMeasure("M", 2048, 400)).toBe(1850)
    expect(approxMeasure("MM", 10)).toBeCloseTo((2 * 1850 * 10) / 2048)
  })

  it("scales with size and grows with weight", () => {
    const r = approxMeasure("leaf-01", 12, 400)
    expect(approxMeasure("leaf-01", 24, 400)).toBeCloseTo(2 * r)
    expect(approxMeasure("leaf-01", 12, 700)).toBeGreaterThan(r)
    const mid = approxMeasure("leaf-01", 12, 500)
    expect(mid).toBeGreaterThan(r)
    expect(mid).toBeLessThan(approxMeasure("leaf-01", 12, 700))
  })

  it("measures accented letters as their base letter", () => {
    expect(approxMeasure("é", 10)).toBe(approxMeasure("e", 10))
    expect(approxMeasure("ø", 10)).toBeGreaterThan(0)
  })

  it("is what measureText uses without a canvas", () => {
    expect(measureText("core-sw-01", 12, 700)).toBe(
      approxMeasure("core-sw-01", 12, 700)
    )
  })
})

describe("fit", () => {
  it("keeps text that fits", () => {
    expect(fit("sw1", 100, 12, 700, approxMeasure)).toBe("sw1")
  })

  it("cuts with an ellipsis to the widest prefix that fits", () => {
    const long = "distribution-switch-building-a-floor-3"
    const out = fit(long, 80, 12, 700, approxMeasure)
    expect(out.endsWith("…")).toBe(true)
    expect(approxMeasure(out, 12, 700)).toBeLessThanOrEqual(80)
    const longer = long.slice(0, out.length) + "…"
    expect(approxMeasure(longer, 12, 700)).toBeGreaterThan(80)
  })

  it("gives up on a box narrower than the ellipsis", () => {
    expect(fit("abc", 2, 12, 700, approxMeasure)).toBe("")
  })
})

describe("baselineAt", () => {
  it("centres the content area in the line box", () => {
    // Inter: ascent 0.96875 em, descent 0.2412 em.
    const b = baselineAt(0, 12, 16)
    expect(b).toBeGreaterThan(11)
    expect(b).toBeLessThan(13.5)
    expect(baselineAt(10, 12, 16)).toBeCloseTo(b + 10)
  })
})
