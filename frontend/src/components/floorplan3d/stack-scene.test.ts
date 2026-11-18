import { describe, expect, it, vi } from "vitest"

import { StackHighlightStore } from "./stack-scene"
import { edgeColor, DEVICE_EDGE, DEVICE_SELECTED } from "./device-mesh"

describe("stack highlight", () => {
  it("lights every member of the hovered or selected stack", () => {
    const h = new StackHighlightStore()
    const fn = vi.fn()
    h.subscribe(fn)
    h.hover("s1")
    expect(h.look("s1")).toBe("hover")
    expect(h.look("s2")).toBeNull()
    h.select("s2")
    expect(h.look("s2")).toBe("select")
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it("selection wins over hover", () => {
    const h = new StackHighlightStore()
    h.hover("s1")
    h.select("s1")
    expect(h.look("s1")).toBe("select")
  })

  it("leaving a stack does not undo a later hover", () => {
    const h = new StackHighlightStore()
    h.hover("s1")
    h.hover("s2")
    h.hover(null, "s1")
    expect(h.hovered).toBe("s2")
    h.hover(null, "s2")
    expect(h.hovered).toBeNull()
    h.select("s1")
    h.select(null, "s2")
    expect(h.selected).toBe("s1")
  })

  it("a selected stack's members take the selection's edge", () => {
    expect(edgeColor(false, "select")).toBe(DEVICE_SELECTED)
    expect(edgeColor(false, "hover")).toBe(DEVICE_EDGE)
    expect(edgeColor(true, null)).toBe(DEVICE_SELECTED)
  })
})
