// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"

import type { CheckStatus, StatusMini, TopoNode } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { cardContent } from "./card-fields"
import { cardLayout, NUB } from "./card-layout"
import { CardNode } from "./card-node"
import type { DiagramCardData } from "./types"

// The Diagram card, as the owner drew it: a solid box in the role's colour,
// text in a colour that reads on it, a pill (never a dot) inside the
// top-left corner, grey nubs on the edge in Detailed, and an outline - not a
// shadow - when selected.

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
  card: {
    fields: ["monitor", "primary_ip", "serial"],
    source: "default",
    values: {
      primary_ip: { id: "ip1", address: "10.0.0.1", cidr: "10.0.0.1/24" },
      serial: "FDO2231X0AB",
    },
  },
}

function cardData(
  data: TopoNode["data"],
  extra: Partial<DiagramCardData> = {},
  nubs: DiagramCardData["diagram"]["nubs"] = []
): DiagramCardData {
  const content = cardContent(data)
  const demand = { T: 0, R: 0, B: 0, L: 0 }
  for (const n of nubs) demand[n.side]++
  const box = cardLayout(
    {
      name: content.name,
      color: data.role?.color,
      lines: content.lines,
      pillSlot: content.pillSlot,
    },
    nubs.length ? demand : null,
    approxMeasure
  )
  return {
    ...data,
    diagram: { box, nubs, mode: nubs.length ? "detailed" : "simple" },
    ...extra,
  }
}

function renderCard(data: DiagramCardData, selected = false) {
  const props = { id: "n1", data, selected } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <CardNode {...props} />
    </ReactFlowProvider>
  )
}

const card = (c: HTMLElement) => c.querySelector("[data-card]") as HTMLElement

describe("CardNode", () => {
  it("fills the card with the role colour and readable ink", () => {
    const { container } = renderCard(cardData(base))
    const el = card(container)
    expect(el.style.backgroundColor).toBe("rgb(99, 102, 241)")
    // White on indigo, by lib/color's readableText.
    expect(el.style.color).toBe("rgb(255, 255, 255)")
    expect(el.className).not.toMatch(/bg-muted/)
  })

  it("prints dark ink on a pale role", () => {
    const pale = { ...base, role: { name: "Spare", color: "#fde68a" } }
    const { container } = renderCard(cardData(pale))
    expect(card(container).style.color).toBe("rgb(10, 10, 10)")
  })

  it("is a neutral card without a role colour", () => {
    const { container } = renderCard(cardData({ ...base, role: null }))
    const el = card(container)
    expect(el.style.backgroundColor).toBe("")
    expect(el.className).toMatch(/bg-muted/)
    expect(el.className).toMatch(/text-foreground/)
  })

  it("puts the bold name above value-only lines", () => {
    renderCard(cardData(base))
    const name = screen.getByText("leaf-01")
    expect(name.className).toMatch(/font-bold/)
    expect(name.className).toMatch(/text-center/)
    expect(screen.getByText("10.0.0.1")).toBeTruthy()
    expect(screen.getByText("SN FDO2231X0AB")).toBeTruthy()
  })

  it("shows the Down pill while the device is down", () => {
    const { container } = renderCard(
      cardData(base, { monitor: "down" as CheckStatus })
    )
    const pill = screen.getByText("Down")
    expect(pill.className).toMatch(/rounded-\[5px\]/)
    // Inside the card, at the top-left.
    const slot = pill.parentElement as HTMLElement
    expect(card(container).contains(slot)).toBe(true)
    expect(Number.parseFloat(slot.style.left)).toBeGreaterThan(0)
    expect(Number.parseFloat(slot.style.top)).toBeGreaterThan(0)
  })

  it("shows no pill while the device is up", () => {
    renderCard(cardData(base, { monitor: "up" }))
    expect(screen.queryByText("Down")).toBeNull()
    expect(screen.queryByText("Up")).toBeNull()
  })

  it("shows the lifecycle status as a badge when it is listed", () => {
    const withStatus = {
      ...base,
      card: { ...base.card!, fields: ["status", "primary_ip"] },
    }
    renderCard(cardData(withStatus))
    const pill = screen.getByText("Planned")
    expect(pill.dataset.slot).toBe("badge")
    expect(pill.style.backgroundColor).toBe("rgb(14, 165, 233)")
  })

  it("draws no status dot", () => {
    const { container } = renderCard(
      cardData(base, { monitor: "down" as CheckStatus })
    )
    expect(container.querySelectorAll(".rounded-full")).toHaveLength(0)
  })

  it("marks a selected card with an outline, not a shadow", () => {
    const { container } = renderCard(cardData(base), true)
    const el = card(container)
    expect(el.className).toMatch(/outline-2/)
    expect(el.className).toMatch(/outline-primary/)
    expect(el.className).not.toMatch(/shadow|ring-2/)
    expect(el.style.boxShadow).toBe("")
  })

  it("puts one grey nub per interface outside the edge in Detailed", () => {
    const nubs: DiagramCardData["diagram"]["nubs"] = [
      {
        link: "e1",
        cable: 0,
        end: "a",
        port: "Ethernet1/49",
        side: "T",
        off: 40,
      },
      {
        link: "e2",
        cable: 0,
        end: "a",
        port: "Ethernet1/50",
        side: "T",
        off: 56,
      },
      {
        link: "e3",
        cable: 0,
        end: "b",
        port: "Ethernet1/1",
        side: "B",
        off: 48,
      },
    ]
    const { container } = renderCard(cardData(base, {}, nubs))
    const drawn = [...container.querySelectorAll<HTMLElement>(".topo-nub")]
    expect(drawn.map((n) => n.dataset.port)).toEqual([
      "Ethernet1/49",
      "Ethernet1/50",
      "Ethernet1/1",
    ])
    // Top nubs stand out above the card.
    expect(drawn[0].style.top).toBe(`${-NUB.OUT}px`)
    expect(drawn[0].className).toMatch(/rounded-\[2px\]/)
  })

  it("fades a search miss", () => {
    const { container } = renderCard(cardData(base, { dimmed: true }))
    expect(card(container).className).toMatch(/opacity-30/)
  })
})
