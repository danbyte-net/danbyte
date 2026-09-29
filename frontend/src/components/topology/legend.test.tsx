// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { CanvasLegend, graphLegend, legendRows } from "./legend"

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

describe("an embedded map's legend", () => {
  const graph: TopologyGraph = {
    nodes: [
      {
        id: "dev:a",
        type: "device",
        data: { name: "leaf-01", role: { name: "Leaf", color: "0ea5e9" } },
      },
      {
        id: "dev:b",
        type: "device",
        data: { name: "spine-01", role: { name: "Spine", color: "6366f1" } },
      },
      {
        id: "dev:p",
        type: "device",
        data: {
          name: "pp-01",
          panel: true,
          role: { name: "Leaf", color: "0ea5e9" },
        },
      },
    ],
    edges: [
      {
        id: "c1",
        source: "dev:a",
        target: "dev:p",
        type: "cable",
        data: { marked: true },
      },
      { id: "c2", source: "dev:p", target: "dev:b", type: "cable", data: {} },
    ],
    meta: { card: { fields: [], source: "default", uses_monitor: true } },
  }

  it("reads the roles, the pill and the lines off the payload", () => {
    expect(graphLegend(graph)).toEqual({
      roles: [
        { name: "Leaf", color: "0ea5e9" },
        { name: "Spine", color: "6366f1" },
      ],
      monitorPill: true,
      present: {
        bundle: false,
        via: false,
        ghost: false,
        bgp: false,
        traced: true,
        panel: true,
      },
    })
  })

  it("lists only what the map draws: the run, and the dashed panel", () => {
    const rows = legendRows({
      viewStyle: "diagram",
      grouped: false,
      colorMode: "cable",
      ...graphLegend(graph),
    })
    expect(rows.map((r) => r.label)).toEqual([
      "Leaf",
      "Spine",
      "Monitoring",
      "Cable",
      "Traced run",
      "Patch panel",
      "Color by cable",
    ])
    expect(rows.find((r) => r.label === "Traced run")).toMatchObject({
      kind: "line",
      color: "var(--primary)",
      width: 2.5,
    })
  })

  it("starts on its chip and is remembered apart from the map's", () => {
    localStorage.removeItem("embedded-test")
    localStorage.setItem("topology:legend", "open")
    render(
      <TooltipProvider>
        <CanvasLegend
          viewStyle="diagram"
          grouped={false}
          colorMode="cable"
          storageKey="embedded-test"
          defaultOpen={false}
        />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Legend" }))
    expect(localStorage.getItem("embedded-test")).toBe("open")
    expect(localStorage.getItem("topology:legend")).toBe("open")
    expect(screen.getByRole("button", { name: "Hide legend" })).toBeTruthy()
  })
})
