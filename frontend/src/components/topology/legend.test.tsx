// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { CanvasLegend, legendRows } from "./legend"

// The map's legend: roles as their badges and colour keys as lines -
// never a coloured dot beside a name.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)

describe("CanvasLegend", () => {
  it("shows roles as badges and speed tiers as coloured lines", () => {
    const { container } = render(
      <CanvasLegend
        viewStyle="diagram"
        grouped={false}
        colorMode="speed"
        roles={[
          { name: "Spine", color: "6366f1" },
          { name: "Leaf", color: "0ea5e9" },
        ]}
      />
    )
    expect(screen.getByText("Spine")).toBeTruthy()
    expect(screen.getByText("10G")).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
    const tier = screen.getByText("10G").previousElementSibling!
    expect(tier.nodeName.toLowerCase()).toBe("svg")
    expect(tier.querySelector("line")!.getAttribute("stroke")).toBe("#0ea5e9")
  })

  it("keys the media types as lines too", () => {
    const { container } = render(
      <CanvasLegend
        viewStyle="hierarchy"
        grouped={false}
        colorMode="type"
        types={["cat6", "om4"]}
      />
    )
    expect(screen.getByText("cat6")).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })
})

describe("CanvasLegend chrome", () => {
  it("is a bordered chip without a shadow, closed with a tipped icon button", () => {
    localStorage.removeItem("topology:legend")
    const { container } = render(
      <TooltipProvider>
        <CanvasLegend viewStyle="diagram" grouped={false} colorMode="cable" />
      </TooltipProvider>
    )
    const box = container.firstElementChild as HTMLElement
    expect(box.className).not.toMatch(/shadow|backdrop-blur/)
    const hide = screen.getByRole("button", { name: "Hide legend" })
    expect(hide.getAttribute("data-size")).toBe("icon-xs")
    fireEvent.focus(hide)
    expect(screen.getByRole("tooltip").textContent).toContain("Hide legend")
    fireEvent.click(hide)
    // Collapsed: a list icon, not the info icon InfoTip uses.
    const show = screen.getByRole("button", { name: "Legend" })
    expect(show.querySelector(".lucide-list")).not.toBeNull()
    expect(show.querySelector(".lucide-info")).toBeNull()
    expect(show.className).toContain("shadow-none")
    expect(localStorage.getItem("topology:legend")).toBe("closed")
    fireEvent.click(show)
    expect(screen.getByRole("button", { name: "Hide legend" })).toBeTruthy()
  })
})

describe("legendRows", () => {
  it("lists the Diagram's roles, then its line styles", () => {
    const rows = legendRows({
      viewStyle: "diagram",
      grouped: false,
      colorMode: "cable",
      roles: [{ name: "Spine", color: "#6366f1" }],
    })
    expect(rows[0]).toEqual({ kind: "role", label: "Spine", color: "#6366f1" })
    expect(rows.some((r) => r.kind === "line" && r.sem === "cable")).toBe(true)
  })

  it("keys the Hierarchy's role headers and pill as the Diagram does", () => {
    const rows = legendRows({
      viewStyle: "hierarchy",
      grouped: false,
      colorMode: "cable",
      roles: [{ name: "Spine", color: "#6366f1" }],
      monitorPill: true,
    })
    expect(rows.slice(0, 2)).toEqual([
      { kind: "role", label: "Spine", color: "#6366f1" },
      { kind: "pill", label: "Monitoring" },
    ])
    // Its own lines and the dashed patch panel follow.
    expect(rows.map((r) => r.label)).toContain("LAG bundle")
    expect(rows.map((r) => r.label)).toContain("Patch panel")
  })

  it("names bundles plainly and repeats the Color by option", () => {
    const labels = (viewStyle: "diagram" | "hierarchy", colorMode = "cable") =>
      legendRows({
        viewStyle,
        grouped: false,
        colorMode: colorMode as "cable" | "type" | "status",
      }).map((r) => r.label)
    expect(labels("diagram")).toContain("Bundle")
    expect(labels("hierarchy")).toContain("LAG bundle")
    expect(labels("diagram")).toContain("Color by cable")
    expect(labels("hierarchy", "status")).toContain("Color by status")
    // A type legend with no types on the map says which mode it is.
    expect(labels("diagram", "type")).toContain("Color by type")
    // No parenthesised counts: the chips on the lines carry those.
    expect(labels("diagram").some((l) => l.includes("("))).toBe(false)
  })
})
