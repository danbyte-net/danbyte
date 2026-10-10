// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import {
  CAD_MIN_CONTRAST,
  CAD_SURFACE,
  contrast,
  contrastSafe,
  parseHex,
  themeCadColours,
  themeCadSvgText,
} from "./cad-colour"

// CAD colours on the floor: the drawing's own colour unless it would be too
// faint on the theme's floor, then the same hue at the nearest lightness
// that reads.

const ratio = (a: string, b: string) => contrast(parseHex(a)!, parseHex(b)!)

describe("contrastSafe", () => {
  it("keeps a colour that already reads", () => {
    expect(contrastSafe("#FF0000", CAD_SURFACE.light)).toBe("#ff0000")
    expect(contrastSafe("#00ffff", CAD_SURFACE.dark)).toBe("#00ffff")
  })

  it.each([
    ["#ffff00", "light"],
    ["#00ff00", "light"],
    ["#c0c0c0", "light"],
    ["#0000ff", "dark"],
    ["#404040", "dark"],
    ["#800000", "dark"],
  ] as const)("lifts %s on the %s floor to 3:1", (hex, theme) => {
    const out = contrastSafe(hex, CAD_SURFACE[theme])
    expect(out).not.toBe(hex)
    expect(ratio(out, CAD_SURFACE[theme])).toBeGreaterThanOrEqual(
      CAD_MIN_CONTRAST - 0.01
    )
  })

  it("keeps the hue: a yellow stays a yellow", () => {
    const [r, g, b] = parseHex(contrastSafe("#ffff00", CAD_SURFACE.light))!
    expect(Math.abs(r - g)).toBeLessThan(3)
    expect(b).toBeLessThan(5)
  })

  it("passes keywords through", () => {
    expect(contrastSafe("currentColor", CAD_SURFACE.light)).toBe("currentColor")
    expect(contrastSafe("none", CAD_SURFACE.dark)).toBe("none")
  })
})

describe("theming a drawing", () => {
  it("maps stroke and fill colours in place, leaving currentColor", () => {
    const doc = new DOMParser().parseFromString(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><path stroke="#ffff00"/><text fill="currentColor"/></g></svg>',
      "image/svg+xml"
    )
    themeCadColours(doc.documentElement, "light")
    expect(doc.querySelector("path")!.getAttribute("stroke")).not.toBe(
      "#ffff00"
    )
    expect(doc.querySelector("text")!.getAttribute("fill")).toBe("currentColor")
  })

  it("themes the image text and sets the root's foreground", () => {
    const text = themeCadSvgText(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" color="#000000"><path stroke="#0000ff" fill="none"/></svg>',
      "dark",
      "#fafafa"
    )
    expect(text).toContain('color="#fafafa"')
    expect(text).not.toContain('color="#000000"')
    expect(text).not.toContain('stroke="#0000ff"')
    expect(text).toContain('fill="none"')
  })
})
