// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { KIND_COLOR } from "./connections-layer"
import { SiteMapLegend } from "./site-map-legend"

// The site map's key, in the maps' shared legend frame.

afterEach(cleanup)
beforeEach(() => localStorage.clear())

const mount = () =>
  render(
    <TooltipProvider>
      <SiteMapLegend />
    </TooltipProvider>
  )

describe("SiteMapLegend", () => {
  it("starts folded, opens, and remembers it as before", () => {
    mount()
    expect(screen.queryByText("Circuit")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Legend" }))
    expect(screen.getByText("Circuit")).toBeTruthy()
    expect(localStorage.getItem("site-map:legend")).toBe("open")
    cleanup()
    // The key the page used before the shared frame: an open legend stays open.
    mount()
    expect(screen.getByText("Circuit")).toBeTruthy()
  })

  it("is solid - no shadow, no blur, nothing behind showing through", () => {
    localStorage.setItem("site-map:legend", "open")
    const { container } = mount()
    const box = container.querySelector("[data-slot=map-legend]")!
    expect(box.className).toContain("bg-background")
    expect(box.className).not.toMatch(/shadow|backdrop-blur|bg-background\//)
  })

  it("keys the lines as the map draws them", () => {
    localStorage.setItem("site-map:legend", "open")
    mount()
    const line = (label: string) =>
      screen.getByText(label).previousElementSibling!.querySelector("line")!
    expect(line("Circuit").getAttribute("stroke")).toBe(KIND_COLOR.circuit)
    expect(line("Tunnel").getAttribute("stroke")).toBe(KIND_COLOR.tunnel)
    expect(line("Cable").getAttribute("stroke")).toBe(KIND_COLOR.cable)
    // An un-routed cable is dashed on the map (cable-geo-route.ts), and here.
    expect(
      line("Cable without a drawn route").getAttribute("stroke-dasharray")
    ).toBe("5 4")
  })

  it("names the monitoring states as their pills", () => {
    localStorage.setItem("site-map:legend", "open")
    mount()
    for (const s of ["Up", "Degraded", "Down"])
      expect(screen.getByText(s).className).toContain("rounded-[5px]")
  })
})
