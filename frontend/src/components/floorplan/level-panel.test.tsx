// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanFloor, FloorPlanStack } from "@/lib/api"

import { createExplodeStore } from "./level-explode"
import { LevelPanel } from "./level-panel"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis))
  (globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub

const floor = (id: string, elevation: number): FloorPlanFloor => ({
  id,
  numid: null,
  name: id,
  floor_order: 0,
  location_id: null,
  kind: "plan",
  elevation,
  grid_width: 20,
  grid_height: 10,
  cell_mm: 500,
})

const stack = {
  aligned: true,
  floors: [floor("g", 0), floor("1", 3300)],
} as unknown as FloorPlanStack

function panel(explode = createExplodeStore(1)) {
  render(
    <LevelPanel
      stack={stack}
      currentId="g"
      onGo={() => {}}
      view3d
      onion="off"
      onOnion={() => {}}
      mode="all"
      onMode={() => {}}
      explode={explode}
    />
  )
  return explode
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"],
  })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("Animate levels", () => {
  it("closes the levels up over about four seconds, then back", () => {
    const explode = panel()
    const play = screen.getByRole("button", { name: "Animate levels" })
    fireEvent.click(play)
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(explode.get()).toBeGreaterThan(0.2)
    expect(explode.get()).toBeLessThan(0.8)
    // The slider follows the tween.
    const thumb = screen.getByRole("slider", { name: "Explode" })
    expect(Number(thumb.getAttribute("aria-valuenow"))).toBe(
      Math.round(explode.get() * 100)
    )
    act(() => {
      vi.advanceTimersByTime(2100)
    })
    expect(explode.get()).toBe(0)
    fireEvent.click(play)
    act(() => {
      vi.advanceTimersByTime(4100)
    })
    expect(explode.get()).toBe(1)
  })

  it("slider keys set the store, not a parent's state", () => {
    const explode = panel(createExplodeStore(0))
    const thumb = screen.getByRole("slider", { name: "Explode" })
    fireEvent.keyDown(thumb, { key: "ArrowRight" })
    expect(explode.get()).toBeCloseTo(0.05)
  })
})
