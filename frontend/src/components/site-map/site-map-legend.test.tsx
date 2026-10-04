// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { speedTier } from "@/lib/speed"
import { KIND_COLOR } from "./connections-layer"
import { lineKey, NO_VALUE_HEX } from "./line-style"
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

// The line rows follow Color by (#246): the kinds' colours under Type, the
// statuses on the lines as their pills under Status, the speed tiers on the
// lines under Speed - each keying only what the map draws.

const ACTIVE = { name: "Active", color: "#10b981" }
const PLANNED = { name: "Planned", color: "#f59e0b" }

const mountMode = (
  colorBy: "type" | "status" | "speed",
  lines = lineKey([
    { kind: "circuit", status: ACTIVE, capacity: { kbps: 100_000_000 } },
    { kind: "cable", status: PLANNED, capacity: { kbps: 10_000_000 } },
    { kind: "tunnel", status: null, capacity: null },
  ])
) => {
  localStorage.setItem("site-map:legend", "open")
  return render(
    <TooltipProvider>
      <SiteMapLegend colorBy={colorBy} lines={lines} />
    </TooltipProvider>
  )
}

describe("SiteMapLegend - Color by", () => {
  it("Type keys the kinds, as before", () => {
    mountMode("type")
    for (const k of ["Circuit", "Tunnel", "Cable"])
      expect(screen.getByText(k)).toBeTruthy()
    expect(screen.queryByText("Color by status")).toBeNull()
    expect(screen.queryByText("Active")).toBeNull()
  })

  it("Status keys the lines' statuses as pills, and the lines without one", () => {
    const { container } = mountMode("status")
    expect(screen.getByText("Color by status")).toBeTruthy()
    expect(screen.queryByText("Circuit")).toBeNull()
    for (const s of [ACTIVE, PLANNED]) {
      const pill = screen.getByText(s.name)
      // A pill in the status's own colour - never a dot beside its name.
      expect(pill.getAttribute("data-slot")).toBe("badge")
      expect(pill.getAttribute("style")).toContain("background-color")
      expect(pill.parentElement!.querySelector(".rounded-full")).toBeNull()
    }
    const none = screen.getByText("No status").previousElementSibling!
    expect(none.querySelector("line")!.getAttribute("stroke")).toBe(
      NO_VALUE_HEX
    )
    expect(container.querySelector("[data-slot=line-key]")).toBeTruthy()
  })

  it("Speed keys the tiers on the lines, slow to fast, and Unknown", () => {
    mountMode("speed")
    expect(screen.getByText("Color by speed")).toBeTruthy()
    const tone = (label: string) =>
      screen.getByText(label).previousElementSibling!.querySelector("line")!
    expect(tone("10G").getAttribute("stroke")).toBe(speedTier(10_000).hex)
    expect(tone("100G").getAttribute("stroke")).toBe(speedTier(100_000).hex)
    expect(tone("Unknown").getAttribute("stroke")).toBe(NO_VALUE_HEX)
    // Tiers no line falls in stay out.
    expect(screen.queryByText("1G")).toBeNull()
    const key = screen.getByText("10G").closest("[data-slot=line-key]")!
    expect(key.textContent.indexOf("10G")).toBeLessThan(
      key.textContent.indexOf("100G")
    )
  })

  it("keys the un-routed dash in every mode", () => {
    for (const mode of ["type", "status", "speed"] as const) {
      mountMode(mode)
      const dash = screen
        .getByText("Cable without a drawn route")
        .previousElementSibling!.querySelector("line")!
      expect(dash.getAttribute("stroke-dasharray")).toBe("5 4")
      cleanup()
    }
  })
})
