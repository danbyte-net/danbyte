// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { objectsStartOpen } from "./map-sidebar"

function viewport(width: number) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: q === "(max-width: 767px)" && width < 768,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe("objectsStartOpen (#476)", () => {
  it("starts closed below md, whatever was stored", () => {
    for (const w of [320, 390, 430]) {
      viewport(w)
      localStorage.setItem("site-map:sidebar", "open")
      expect(objectsStartOpen("site-map:sidebar")).toBe(false)
    }
  })

  it("keeps the stored choice from md up", () => {
    viewport(1280)
    expect(objectsStartOpen("site-map:sidebar")).toBe(true)
    localStorage.setItem("site-map:sidebar", "closed")
    expect(objectsStartOpen("site-map:sidebar")).toBe(false)
  })
})
