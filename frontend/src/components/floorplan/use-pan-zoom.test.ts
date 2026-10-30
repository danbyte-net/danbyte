// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import type React from "react"
import { describe, expect, it } from "vitest"

import { pinchTransform, usePanZoom } from "./use-pan-zoom"

// Two fingers on a touch screen zoom the plan as the wheel does: about the
// point between them, inside the same limits, and panning as they move.

const svg = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
}
const touch = (
  pointerId: number,
  x: number,
  y: number,
  pointerType = "touch"
) =>
  ({
    pointerId,
    pointerType,
    clientX: x,
    clientY: y,
    currentTarget: svg,
  }) as unknown as React.PointerEvent<SVGSVGElement>

describe("pinchTransform", () => {
  const start = { t: { x: 0, y: 0, k: 1 }, dist: 100, mid: { x: 200, y: 100 } }

  it("zooms about the midpoint by how far the fingers spread", () => {
    const t = pinchTransform(start, 200, { x: 200, y: 100 })
    expect(t.k).toBe(2)
    // The world point under the midpoint stays under it.
    expect((200 - t.x) / t.k).toBe(200)
    expect((100 - t.y) / t.k).toBe(100)
  })

  it("pans with the midpoint", () => {
    const t = pinchTransform(start, 100, { x: 250, y: 130 })
    expect(t).toEqual({ k: 1, x: 50, y: 30 })
  })

  it("keeps to the wheel's zoom limits", () => {
    expect(pinchTransform(start, 10_000, start.mid).k).toBe(4)
    expect(pinchTransform(start, 1, start.mid).k).toBe(0.15)
  })
})

describe("usePanZoom pinch", () => {
  it("one finger is not a pinch; the second starts one", () => {
    const { result } = renderHook(() => usePanZoom({ x: 0, y: 0, k: 1 }))
    expect(result.current.pinchDown(touch(1, 100, 100))).toBe(false)
    expect(result.current.pinchMove(touch(1, 110, 100))).toBe(false)
    expect(result.current.pinchDown(touch(2, 300, 100))).toBe(true)
  })

  it("spreading two fingers zooms in about their midpoint", () => {
    const { result } = renderHook(() => usePanZoom({ x: 0, y: 0, k: 1 }))
    act(() => {
      result.current.pinchDown(touch(1, 100, 100))
      result.current.pinchDown(touch(2, 300, 100))
    })
    act(() => {
      result.current.pinchMove(touch(1, 0, 100))
      result.current.pinchMove(touch(2, 400, 100))
    })
    const { t } = result.current
    expect(t.k).toBe(2)
    expect((200 - t.x) / t.k).toBe(200)
  })

  it("the finger left after a pinch does not pan until it lifts", () => {
    const { result } = renderHook(() => usePanZoom({ x: 0, y: 0, k: 1 }))
    act(() => {
      result.current.pinchDown(touch(1, 100, 100))
      result.current.pinchDown(touch(2, 300, 100))
    })
    expect(result.current.pinchUp(touch(2, 300, 100))).toBe(true)
    expect(result.current.pinchMove(touch(1, 150, 100))).toBe(true)
    expect(result.current.pinchUp(touch(1, 150, 100))).toBe(true)
    // All fingers up: the next touch starts fresh.
    expect(result.current.pinchDown(touch(3, 100, 100))).toBe(false)
  })

  it("a mouse never pinches", () => {
    const { result } = renderHook(() => usePanZoom())
    expect(result.current.pinchDown(touch(1, 0, 0, "mouse"))).toBe(false)
    expect(result.current.pinchDown(touch(2, 50, 0, "mouse"))).toBe(false)
    expect(result.current.pinchUp(touch(1, 0, 0, "mouse"))).toBe(false)
  })
})
