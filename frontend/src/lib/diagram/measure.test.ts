import { describe, expect, it } from "vitest"

import {
  EXACT_SIZE,
  approxMeasure,
  baselineAt,
  canvasWidth,
  fit,
  measureText,
  wrapText,
} from "./measure"
import type { Measure } from "./measure"

describe("wrapText", () => {
  // Every character half its font size wide: 5 px at size 10.
  const mono: Measure = (t, size) => (Array.from(t).length * size) / 2
  const wrap = (t: string, maxW: number) => wrapText(t, maxW, 10, 700, mono)

  it("keeps a text that fits on one row", () => {
    expect(wrap("leaf-01", 100)).toEqual(["leaf-01"])
    expect(wrap("  ", 100)).toEqual([])
  })

  it("breaks at spaces, every row within the width", () => {
    const rows = wrap("Sede Ceas de Medicina Interna", 60)
    expect(rows).toEqual(["Sede Ceas de", "Medicina", "Interna"])
    for (const r of rows) expect(mono(r, 10)).toBeLessThanOrEqual(60)
  })

  it("breaks after separators in a name without spaces", () => {
    expect(wrap("core-sw01.dc1.example.com", 60)).toEqual([
      "core-sw01.",
      "dc1.example.",
      "com",
    ])
  })

  it("splits a part wider than a row by letters, never with an ellipsis", () => {
    const rows = wrap("x".repeat(25), 50)
    expect(rows).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)])
    expect(rows.join("")).toBe("x".repeat(25))
    expect(rows.some((r) => r.includes("…"))).toBe(false)
  })

  it("measures with the measure it is given", () => {
    const name = "Sede Ceas de Medicina Interna Bloco Norte"
    const maxW = 120
    const rows = wrapText(name, maxW, 12, 700, approxMeasure)
    expect(rows.length).toBeGreaterThan(1)
    for (const r of rows)
      expect(approxMeasure(r, 12, 700)).toBeLessThanOrEqual(maxW)
    expect(rows.join(" ")).toBe(name)
  })
})

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

describe("canvasWidth", () => {
  /** A canvas that hints like Chromium's: whole-pixel widths at the size
   * the font is set at. */
  function hinting() {
    const ctx = {
      font: "",
      measureText(t: string) {
        const size = Number(/ (\d+)px /.exec(ctx.font)![1])
        return { width: Math.round(approxMeasure(t, size)) }
      },
    }
    return ctx
  }

  it("measures as HTML sets it at the size itself", () => {
    const c = hinting()
    expect(canvasWidth(c, "Ethernet1/2", 9, 400, false)).toBe(
      Math.round(approxMeasure("Ethernet1/2", 9))
    )
    expect(c.font).toContain(" 9px ")
  })

  it("measures an exact width at the reference size, scaled", () => {
    const c = hinting()
    const w = canvasWidth(c, "Ethernet1/2", 9, 400, true)
    expect(c.font).toContain(` ${EXACT_SIZE}px `)
    expect(w).toBeCloseTo(approxMeasure("Ethernet1/2", 9), 1)
    expect(Number.isInteger(w)).toBe(false)
  })

  it("is exact or not alike without a canvas", () => {
    expect(measureText("10.9.5.1", 9, 400, true)).toBe(
      measureText("10.9.5.1", 9, 400)
    )
  })
})
