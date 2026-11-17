import { describe, expect, it } from "vitest"

import { FIBRE_COLOURS, NEUTRAL } from "@/lib/fibre-colours"
import {
  CABLE_PREVIEWS,
  cordSeatNames,
  defaultPreview,
  previewColours,
} from "@/lib/pluggable-preview"

describe("pluggable preview", () => {
  it("opens on the grade a part is for", () => {
    const part = (connector: string, standard = "", wl: number | null = null) =>
      defaultPreview({ connector, standard, wavelength_nm: wl })
    expect(part("lc", "10GBASE-LR", 1310)).toBe("os2")
    expect(part("lc", "10GBASE-SR", 850)).toBe("om4")
    expect(part("lc", "10GBASE-LR")).toBe("os2")
    expect(part("mpo-12", "100GBASE-SR4")).toBe("om4")
    expect(part("rj45")).toBe("cat6")
    expect(part("dac")).toBe("")
    expect(part("iec-c13")).toBe("")
  })

  it("colours each channel by the TIA-598 conventions", () => {
    expect(previewColours("os2")).toEqual({
      cable: NEUTRAL,
      fibre: FIBRE_COLOURS.yellow,
      lc: FIBRE_COLOURS.blue,
    })
    expect(previewColours("os2-apc").lc).toBe(FIBRE_COLOURS.green)
    expect(previewColours("os2", "lc-apc").lc).toBe(FIBRE_COLOURS.green)
    expect(previewColours("om4").fibre).toBe(FIBRE_COLOURS.aqua)
    expect(previewColours("om2").lc).toBe(FIBRE_COLOURS.beige)
    expect(previewColours("")).toEqual({
      cable: NEUTRAL,
      fibre: NEUTRAL,
      lc: NEUTRAL,
    })
    // An unknown value previews neutral.
    expect(previewColours("nope").fibre).toBe(NEUTRAL)
  })

  it("lists every preview once", () => {
    const values = CABLE_PREVIEWS.map((p) => p.value)
    expect(new Set(values).size).toBe(values.length)
  })

  it("seats a cord on its own connector first", () => {
    expect(cordSeatNames("lc", "lc")).toEqual(["lc"])
    expect(cordSeatNames("mpo", "mpo-12")).toEqual(["mpo", "mpo-12"])
    expect(cordSeatNames("rj45", "rj45")).toEqual(["rj45"])
  })
})
