import { describe, expect, it } from "vitest"

import { barFit } from "./bar-fit"

// What of the second bar gives way to More as it narrows: Copy link, then
// Objects, then Undo and Redo.

describe("barFit", () => {
  it("keeps everything on the bar until it is measured", () => {
    expect(barFit(null, true)).toEqual({
      copyLink: false,
      objects: false,
      history: false,
    })
  })

  it("gives way one control at a time as the bar narrows", () => {
    const at = (w: number) => barFit(w, false)
    expect(at(1200)).toEqual({
      copyLink: false,
      objects: false,
      history: false,
    })
    // 1280px with the app sidebar open: only Copy link moves.
    expect(at(936)).toEqual({ copyLink: true, objects: false, history: false })
    expect(at(820)).toEqual({ copyLink: true, objects: true, history: false })
    expect(at(700)).toEqual({ copyLink: true, objects: true, history: true })
  })

  it("makes room for an applied view's Edited, Save and Delete", () => {
    // At 1280px a view sends all three into More, on the Diagram and the
    // Hierarchy alike - both have the Devices toggle.
    expect(barFit(936, true)).toEqual({
      copyLink: true,
      objects: true,
      history: true,
    })
    expect(barFit(1100, true)).toEqual({
      copyLink: true,
      objects: false,
      history: false,
    })
  })
})
