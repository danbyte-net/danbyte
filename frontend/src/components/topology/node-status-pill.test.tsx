// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"

import type { StatusMini } from "@/lib/api"
import { FlatNode, flatW } from "./flat-node"
import { HierarchyNode } from "./hierarchy-node"
import { hierarchyWidth } from "./layout"
import { NodeStatusPill, statusPillReserve } from "./node-status-pill"
import { StencilNode, stencilSize } from "./stencil-node"

// A card's lifecycle status is the shared StatusBadge pill, coloured from the
// status row - never a coloured dot - and the card grows to fit it.

afterEach(cleanup)

const planned: StatusMini = {
  id: "s-planned",
  name: "Planned",
  slug: "planned",
  color: "#0ea5e9",
  text_color: "#ffffff",
}

const device = {
  name: "leaf-01",
  device_id: "d1",
  status: "planned",
  status_display: "Planned",
  status_mini: planned,
  role: { name: "Leaf", color: "#6366f1" },
  device_type: "N9K",
  site: "DC1",
  primary_ip: "10.0.0.1",
  ports: [{ name: "Ethernet1/1", kind: "interface" as const }],
}

function renderNode(Node: (p: NodeProps) => React.ReactNode, data: object) {
  const props = { id: "n1", data, selected: false } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <Node {...props} />
    </ReactFlowProvider>
  )
}

describe("statusPillReserve", () => {
  it("reserves nothing without a status", () => {
    expect(statusPillReserve({})).toBe(0)
    expect(statusPillReserve({ status_mini: null })).toBe(0)
  })

  it("grows with the name and caps a long one", () => {
    const short = statusPillReserve({ status_mini: { name: "Active" } })
    const long = statusPillReserve({
      status_mini: { name: "Decommissioning" },
    })
    const huge = statusPillReserve({ status_mini: { name: "x".repeat(80) } })
    expect(short).toBeGreaterThan(0)
    expect(long).toBeGreaterThan(short)
    expect(huge).toBe(
      statusPillReserve({ status_mini: { name: "y".repeat(60) } })
    )
  })

  it("widens every legacy card for a long status", () => {
    const base = { name: "oob-con-01" }
    const withPill = {
      ...base,
      status_mini: { ...planned, name: "Decommissioning" },
    }
    expect(stencilSize(withPill).width).toBeGreaterThan(stencilSize(base).width)
    expect(flatW(withPill)).toBeGreaterThan(flatW(base))
    expect(hierarchyWidth(withPill)).toBeGreaterThan(hierarchyWidth(base))
  })
})

describe("NodeStatusPill", () => {
  it("renders nothing without a status row", () => {
    const { container } = render(<NodeStatusPill status={null} />)
    expect(container.innerHTML).toBe("")
  })

  it("is a squarish pill filled with the status colour", () => {
    render(<NodeStatusPill status={planned} />)
    const pill = screen.getByText("Planned")
    expect(pill.dataset.slot).toBe("badge")
    expect(pill.className).not.toMatch(/rounded-full/)
    expect(pill.style.backgroundColor).toBe("rgb(14, 165, 233)")
  })
})

describe.each([
  ["Wiring", StencilNode],
  ["Flat", FlatNode],
  ["Hierarchy", HierarchyNode],
])("%s card", (_label, Node) => {
  it("shows the status as a pill and draws no status dot", () => {
    const { container } = renderNode(Node, device)
    const pill = screen.getByText("Planned")
    expect(pill.dataset.slot).toBe("badge")
    // The role spine is the only rounded-full element left on a card.
    const round = [...container.querySelectorAll(".rounded-full")]
    expect(round).toHaveLength(1)
    expect((round[0] as HTMLElement).style.background).toBe("rgb(99, 102, 241)")
  })

  it("draws no pill for a node without status_mini", () => {
    renderNode(Node, { ...device, status_mini: undefined })
    expect(screen.queryByText("Planned")).toBeNull()
  })
})
