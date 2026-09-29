// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"

import type { CheckStatus, StatusMini, TopoNode } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { cardContent } from "./diagram/card-fields"
import { cardLayout } from "./diagram/card-layout"
import { HIER_MIN_W, hierCardBox } from "./hier-card"
import { HierarchyNode } from "./hierarchy-node"
import type { HierData } from "./hierarchy-node"
import {
  HIER_HEADER,
  HIER_PAD,
  hierHead,
  hierHeight,
  hierarchyWidth,
} from "./layout"

// The Hierarchy card wears the Diagram card as its header: the role's
// colour with readable ink, the name bold, the card lines, at most one
// pill in the top-left corner (never a dot) - and its port chips hang on
// the neutral body below. The layout sizes it from the same box.

afterEach(cleanup)

const planned: StatusMini = {
  id: "s-planned",
  name: "Planned",
  slug: "planned",
  color: "#0ea5e9",
  text_color: "#ffffff",
}

const base: TopoNode["data"] = {
  name: "leaf-01",
  device_id: "d1",
  status_mini: planned,
  role: { name: "Leaf", color: "#6366f1" },
  primary_ip: "10.0.0.1",
  site: "DC1",
  card: {
    fields: ["monitor", "primary_ip", "serial"],
    source: "default",
    values: {
      primary_ip: { id: "ip1", address: "10.0.0.1", cidr: "10.0.0.1/24" },
      serial: "FDO2231X0AB",
    },
  },
}

function hierData(
  data: TopoNode["data"],
  extra: Partial<HierData> = {}
): HierData {
  return {
    ...data,
    hierCard: hierCardBox(data, { measure: approxMeasure }),
    portPos: { "Ethernet1/1": { side: "R", off: 70 } },
    portSpan: 0,
    ...extra,
  }
}

function renderCard(data: HierData, selected = false) {
  const props = { id: "n1", data, selected } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <HierarchyNode {...props} />
    </ReactFlowProvider>
  )
}

const card = (c: HTMLElement) => c.querySelector("[data-hier]") as HTMLElement
const header = (c: HTMLElement) => card(c).children[2] as HTMLElement

describe("HierarchyNode", () => {
  it("fills the header with the role colour and readable ink", () => {
    const { container } = renderCard(hierData(base))
    const head = header(container)
    expect(head.style.backgroundColor).toBe("rgb(99, 102, 241)")
    expect(head.style.color).toBe("rgb(255, 255, 255)")
    // The body under it stays neutral.
    expect(card(container).className).toMatch(/bg-card/)
    expect(card(container).style.backgroundColor).toBe("")
  })

  it("is a neutral header without a role colour", () => {
    const { container } = renderCard(hierData({ ...base, role: null }))
    const head = header(container)
    expect(head.style.backgroundColor).toBe("")
    expect(head.className).toMatch(/bg-muted/)
  })

  it("puts the bold name above the card lines, no role dot", () => {
    const { container } = renderCard(hierData(base))
    const name = screen.getByText("leaf-01")
    expect(name.className).toMatch(/font-bold/)
    expect(name.className).toMatch(/text-center/)
    expect(screen.getByText("10.0.0.1")).toBeTruthy()
    expect(screen.getByText("SN FDO2231X0AB")).toBeTruthy()
    // The site is no card line here, and nothing is a dot.
    expect(screen.queryByText(/DC1/)).toBeNull()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("shows the primary IP when the payload has no card lines", () => {
    renderCard(hierData({ ...base, card: undefined }))
    expect(screen.getByText("10.0.0.1")).toBeTruthy()
    expect(screen.queryByText("Planned")).toBeNull()
  })

  it("shows the Down pill in the header while the device is down", () => {
    const { container } = renderCard(
      hierData(base, { monitor: "down" as CheckStatus })
    )
    const pill = screen.getByText("Down")
    expect(header(container).contains(pill)).toBe(true)
    const slot = pill.parentElement as HTMLElement
    expect(Number.parseFloat(slot.style.left)).toBeGreaterThan(0)
  })

  it("shows the lifecycle status only when the card lines list it", () => {
    renderCard(hierData(base))
    expect(screen.queryByText("Planned")).toBeNull()
    cleanup()
    renderCard(
      hierData({ ...base, card: { ...base.card!, fields: ["status"] } })
    )
    const pill = screen.getByText("Planned")
    expect(pill.dataset.slot).toBe("badge")
    expect(pill.className).not.toMatch(/rounded-full/)
  })

  it("keeps its port chips on the body, under the header", () => {
    const d = hierData(base)
    renderCard(d)
    const chip = screen.getByText("Ethernet1/1").parentElement as HTMLElement
    expect(Number.parseFloat(chip.style.top)).toBeGreaterThanOrEqual(
      d.hierCard!.h - 8
    )
  })

  it("outlines the selected card instead of a ring", () => {
    const { container } = renderCard(hierData(base), true)
    expect(card(container).className).toMatch(/outline-primary/)
    expect(card(container).className).not.toMatch(/ring-/)
  })

  it("draws a panel dashed", () => {
    const { container } = renderCard(hierData({ ...base, panel: true }))
    expect(card(container).className).toMatch(/border-dashed/)
  })
})

describe("Hierarchy card size", () => {
  it("is the header box, never narrower than the minimum", () => {
    const d = hierData(base)
    expect(hierarchyWidth(d)).toBe(Math.max(HIER_MIN_W, d.hierCard!.w))
    const long = hierData({ ...base, name: "x".repeat(60) })
    expect(hierarchyWidth(long)).toBe(long.hierCard!.w)
    expect(hierarchyWidth(long)).toBeGreaterThan(HIER_MIN_W)
  })

  it("grows with the card lines, and the chips start under them", () => {
    const one = hierData({
      ...base,
      card: { ...base.card!, fields: ["primary_ip"] },
    })
    const two = hierData(base)
    expect(hierHead(two)).toBeGreaterThan(hierHead(one))
    expect(hierHeight(0, hierHead(two))).toBeGreaterThan(
      hierHeight(0, hierHead(one))
    )
    expect(hierHeight(100, hierHead(two))).toBe(
      hierHead(two) + 2 * HIER_PAD + 100
    )
  })

  it("keeps room for every pill its lines can show", () => {
    const mon = hierData(base)
    const plain = hierData({
      ...base,
      card: { ...base.card!, fields: ["primary_ip", "serial"] },
    })
    // The same box whether the device is up or down.
    const content = cardContent(base)
    const down = cardLayout(
      {
        name: content.name,
        color: base.role?.color,
        lines: content.lines,
        pillSlot: content.pillSlot,
        pill: { kind: "check", text: "Down" },
      },
      null,
      approxMeasure
    )
    expect(down.w).toBe(mon.hierCard!.w)
    expect(mon.hierCard!.w).toBeGreaterThanOrEqual(plain.hierCard!.w)
  })

  it("falls back to a plain header without a box", () => {
    expect(hierHead({ name: "dc1" })).toBe(HIER_HEADER)
    expect(hierarchyWidth({ name: "dc1" })).toBe(HIER_MIN_W)
  })
})
