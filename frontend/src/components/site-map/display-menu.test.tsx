// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { SiteMapDisplayMenu } from "./display-menu"
import type { SiteMapLayers } from "./display-menu"
import { COLOR_BY_KEY, SPEED_LABELS_KEY, useLineDisplay } from "./line-display"

// The site map's Display menu (#246): Layers, Labels and Color by, each in
// its own section, and the two new prefs remembered per browser like the
// map's others.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
  ResizeObserverStub

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const LAYERS: SiteMapLayers = {
  sites: true,
  devices: true,
  links: true,
  cables: true,
  routes: true,
  regions: true,
}

function mount(over: Partial<Parameters<typeof SiteMapDisplayMenu>[0]> = {}) {
  const props = {
    layers: LAYERS,
    onLayersChange: vi.fn(),
    stacking: true,
    onStackingChange: vi.fn(),
    showFov: true,
    onShowFovChange: vi.fn(),
    nameLabels: true,
    onNameLabelsChange: vi.fn(),
    speedLabels: true,
    onSpeedLabelsChange: vi.fn(),
    colorBy: "type" as const,
    onColorByChange: vi.fn(),
    ...over,
  }
  render(
    <TooltipProvider>
      <SiteMapDisplayMenu {...props} />
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: /Display/ }))
  return props
}

describe("SiteMapDisplayMenu", () => {
  it("groups its controls under Layers, Labels and Color by", () => {
    mount()
    const layers = screen.getByRole("region", { name: "Layers" })
    for (const l of [
      "Sites",
      "Devices",
      "Links (circuits · tunnels)",
      "Cables",
      "Cable routes",
      "Region boundaries",
      "Camera FOV cones",
      "Stack nearby markers",
    ])
      expect(within(layers).getByText(l)).toBeTruthy()
    const labels = screen.getByRole("region", { name: "Labels" })
    expect(within(labels).getByText("Names")).toBeTruthy()
    expect(within(labels).getByText("Speed")).toBeTruthy()
    const colorBy = screen.getByRole("region", { name: "Color by" })
    expect(
      within(colorBy)
        .getAllByRole("button")
        .map((b) => b.textContent)
    ).toEqual(["Type", "Status", "Speed"])
  })

  it("reports a layer, the Speed labels and Color by", () => {
    const p = mount()
    fireEvent.click(
      within(screen.getByRole("region", { name: "Layers" })).getByText("Cables")
    )
    expect(p.onLayersChange).toHaveBeenCalledWith({ ...LAYERS, cables: false })
    fireEvent.click(
      within(screen.getByRole("region", { name: "Labels" })).getByText("Speed")
    )
    expect(p.onSpeedLabelsChange).toHaveBeenCalledWith(false)
    fireEvent.click(
      within(screen.getByRole("region", { name: "Color by" })).getByText(
        "Status"
      )
    )
    expect(p.onColorByChange).toHaveBeenCalledWith("status")
  })

  it("marks the current Color by", () => {
    mount({ colorBy: "speed" })
    const current = within(
      screen.getByRole("region", { name: "Color by" })
    ).getByText("Speed")
    expect(current.getAttribute("aria-current")).toBe("page")
  })
})

describe("useLineDisplay", () => {
  it("starts on Type with Speed labels on", () => {
    const { result } = renderHook(() => useLineDisplay())
    expect(result.current.colorBy).toBe("type")
    expect(result.current.speedLabels).toBe(true)
  })

  it("remembers both per browser", () => {
    const { result } = renderHook(() => useLineDisplay())
    act(() => {
      result.current.setColorBy("speed")
      result.current.setSpeedLabels(false)
    })
    expect(localStorage.getItem(COLOR_BY_KEY)).toBe("speed")
    expect(localStorage.getItem(SPEED_LABELS_KEY)).toBe("off")
    const again = renderHook(() => useLineDisplay()).result
    expect(again.current.colorBy).toBe("speed")
    expect(again.current.speedLabels).toBe(false)
  })

  it("falls back to Type for a value it doesn't know", () => {
    localStorage.setItem(COLOR_BY_KEY, "rainbow")
    const { result } = renderHook(() => useLineDisplay())
    expect(result.current.colorBy).toBe("type")
  })
})
