import { describe, expect, it } from "vitest"

import { photoBoxStyle } from "./device-faceplate"

// A photo faceplate held under a height (the floor plan's popover and its
// large view): the box narrows by the photo's aspect, so the markers placed
// over it stay on their ports.

describe("photoBoxStyle", () => {
  const base = { fill: false, photoScale: null, photoW: 800, photoH: 400 }

  it("leaves the box alone without a height or a loaded photo", () => {
    expect(photoBoxStyle(base)).toBeUndefined()
    expect(
      photoBoxStyle({ ...base, photoW: null, maxHeight: "14rem" })
    ).toBeUndefined()
    expect(photoBoxStyle({ ...base, photoScale: 0.5 })).toEqual({ width: 400 })
  })

  it("narrows to the height by the photo's aspect", () => {
    expect(photoBoxStyle({ ...base, maxHeight: "14rem" })).toEqual({
      width: "min(800px, calc(14rem * 2))",
    })
    expect(
      photoBoxStyle({ ...base, photoScale: 0.5, maxHeight: "75dvh" })
    ).toEqual({ width: "min(400px, calc(75dvh * 2))" })
  })

  it("stretches over its wrapper when filling", () => {
    expect(photoBoxStyle({ ...base, fill: true, maxHeight: "14rem" })).toBe(
      undefined
    )
  })
})
