// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { railMeasure, railModel } from "@/lib/diagram/__fixtures__/rails"
import { layoutRails } from "@/lib/diagram/rails"
import { RailDiagram } from "./rail-diagram"
import { RailLegend, railLegendRows } from "./rail-legend"
import { printLegend } from "./diagram/to-document"

// The one rail diagram the Logical tab, the Virtual topology and a VM's
// Topology card draw: links you can tab to, the shared status pills, the
// role colors from data, VMs dashed, and a tip for a name cut short.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)
beforeEach(() => localStorage.clear())

/** `ui` on a real in-memory router, so its links resolve. */
async function mount(ui: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{ui}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByRole("group")
}

const layout = layoutRails(railModel, { measure: railMeasure })

describe("RailDiagram", () => {
  it("draws rails and cards as links to their pages", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    expect(screen.getByRole("group", { name: "Logical topology" })).toBeTruthy()
    const rail = screen.getByRole("link", { name: "MGMT · VLAN 10, Planned" })
    expect(rail.getAttribute("href")).toBe("/vlans/v10")
    const card = screen.getByRole("link", { name: "core-01, Active" })
    expect(card.getAttribute("href")).toBe("/devices/d1")
    expect(
      screen.getByRole("link", { name: "web-01" }).getAttribute("href")
    ).toBe("/virtual-machines/v1")
    // The section title opens its switch; a host NIC its interface.
    expect(
      screen.getByRole("link", { name: "Campus" }).getAttribute("href")
    ).toBe("/virtual-switches/sw-1")
    expect(
      screen.getByRole("link", { name: "eno1, hv-01" }).getAttribute("href")
    ).toBe("/interfaces/if-a1")
  })

  it("colors rails and cards from their data and wears the status pill", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    const rail = screen.getByRole("link", { name: /^MGMT/ })
    expect(rail.style.backgroundColor).toBe("rgb(37, 99, 235)")
    const card = screen.getByRole("link", { name: "core-01, Active" })
    expect(card.style.backgroundColor).toBe("rgb(124, 58, 237)")
    // The shared StatusBadge in the status's own color.
    const pill = screen.getByText("Active")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(pill.style.backgroundColor).toBe("rgb(34, 197, 94)")
    expect(screen.getByText("Planned").style.backgroundColor).toBe(
      "rgb(245, 158, 11)"
    )
    // A card with no role color is the neutral card.
    const vm = screen.getByRole("link", { name: "web-01" })
    expect(vm.className).toContain("bg-muted")
  })

  it("draws a VM dashed and a device solid", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    const edge = (name: string) =>
      screen.getByRole("link", { name }).querySelector("span[aria-hidden]")!
    expect(edge("web-01").className).toContain("border-dashed")
    expect(edge("core-01, Active").className).not.toContain("border-dashed")
  })

  it("names each interface on its legs, each a link to it", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    const [mgmt0] = screen.getAllByRole("link", { name: "mgmt0" })
    expect(mgmt0.getAttribute("href")).toBe("/interfaces/i1")
    expect(mgmt0.parentElement!.textContent).toBe("mgmt0, Eth1/1")
    // A VM interface has no page: plain text.
    expect(screen.getByText("net0").closest("a")).toBeNull()
    // The legs themselves: dashed when tagged, in the rail's color.
    const lines = document.querySelectorAll("svg line")
    expect(lines).toHaveLength(layout.legs.length)
    expect(lines[0].getAttribute("stroke")).toBe("#2563eb")
    expect(lines[1].getAttribute("stroke-dasharray")).toBe("5 5")
  })

  it("keeps a name cut short whole for its tip and its accessible name", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    const long = screen.getByRole("link", {
      name: "a-very-long-access-switch-name",
    })
    expect(long.textContent).toMatch(/…$/)
    expect(long.getAttribute("data-tip")).toBe("a-very-long-access-switch-name")
    // A name drawn whole needs no tip.
    expect(
      screen.getByRole("link", { name: "web-01" }).hasAttribute("data-tip")
    ).toBe(false)
  })

  it("shows the tip of a name cut short when it has keyboard focus", async () => {
    await mount(<RailDiagram layout={layout} label="Logical topology" />)
    const long = screen.getByRole("link", {
      name: "a-very-long-access-switch-name",
    })
    const tip = () =>
      document.querySelector<HTMLElement>("[data-slot=tooltip-content]")
    expect(tip()).toBeNull()
    act(() => long.focus())
    expect(tip()?.textContent).toContain("a-very-long-access-switch-name")
    act(() => long.blur())
    expect(tip()).toBeNull()
  })
})

describe("RailLegend", () => {
  it("keys the roles, the rails, the card kinds and the legs", () => {
    const rows = railLegendRows("logical", {
      roles: [{ name: "Core", color: "#7c3aed" }],
    })
    render(<RailLegend rows={rows} />)
    for (const t of [
      "Legend",
      "Core",
      "VLAN",
      "Device",
      "VM",
      "Untagged",
      "Tagged",
    ])
      expect(screen.getByText(t)).toBeTruthy()
    expect(screen.getByText("Core").style.backgroundColor).toBe(
      "rgb(124, 58, 237)"
    )
  })

  it("folds to a chip and remembers it", () => {
    render(<RailLegend rows={railLegendRows("virtual")} />)
    expect(screen.getByText("Network")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Hide legend" }))
    expect(screen.queryByText("Network")).toBeNull()
    expect(localStorage.getItem("topology:legend")).toBe("closed")
    fireEvent.click(screen.getByRole("button", { name: "Legend" }))
    expect(screen.getByText("Network")).toBeTruthy()
  })

  it("names host NICs only where a switch shows them", () => {
    const labels = (adapters: boolean) =>
      railLegendRows("virtual", { adapters }).map((r) => r.label)
    expect(labels(false)).not.toContain("Host NIC")
    expect(labels(true)).toContain("Host NIC")
  })

  it("prints the roles and the line keys in the exports", () => {
    const rows = printLegend(
      railLegendRows("logical", { roles: [{ name: "Core", color: "#7c3aed" }] })
    )
    expect(rows.map((r) => [r.kind, r.label])).toEqual([
      ["role", "Core"],
      ["line", "VLAN"],
      ["line", "Untagged"],
      ["line", "Tagged"],
    ])
    expect(rows[1]).toMatchObject({ width: 8, stroke: "#71717b" })
    expect(rows[3]).toMatchObject({ dash: "5 5" })
  })
})
