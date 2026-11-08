// @vitest-environment jsdom
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { MuteFilter, muteFilterId, muteRgb, muteTone } from "./background-look"

describe("muted background", () => {
  it("squeezes light toward white and inverts dark toward the page", () => {
    // Light: white stays white, black lifts to a mid grey.
    expect(muteRgb(255, 255, 255, false)).toEqual([255, 255, 255])
    expect(muteRgb(0, 0, 0, false)).toEqual([153, 153, 153])
    // Dark: white streets go near-black, black text a mid grey.
    const [w] = muteRgb(255, 255, 255, true)
    const [k] = muteRgb(0, 0, 0, true)
    expect(w).toBeLessThan(30)
    expect(k).toBeGreaterThan(100)
    expect(k).toBeLessThan(140)
  })

  it("drains most of a colour", () => {
    const [r, g, b] = muteRgb(34, 197, 94, false)
    const spread = Math.max(r, g, b) - Math.min(r, g, b)
    // Green at full strength spreads ~160; muted, a few units.
    expect(spread).toBeLessThan(20)
  })

  it("draws the filter with the same curve", () => {
    const { container } = render(
      <svg>
        <MuteFilter id={muteFilterId("p1")} dark />
      </svg>
    )
    const f = container.querySelector("filter")!
    expect(f.id).toBe("fp-bg-mute-p1")
    const r = f.querySelector("feFuncR")!
    expect(Number(r.getAttribute("slope"))).toBe(muteTone(true).slope)
    expect(Number(r.getAttribute("intercept"))).toBe(muteTone(true).intercept)
  })
})
