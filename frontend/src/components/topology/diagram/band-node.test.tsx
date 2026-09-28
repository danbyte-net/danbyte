// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReactFlow, ReactFlowProvider } from "@xyflow/react"
import type { Node, NodeProps } from "@xyflow/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { fanoutGraph } from "../__fixtures__/fanout-graph"
import { TopologyCanvas } from "../topology-canvas"
import type { Zone } from "../view-positions"
import { ZONE_COLORS } from "../view-positions"
import { BAND } from "./bands"
import {
  BAND_DRAG_HANDLE,
  BAND_NODE_CLASS,
  BandNode,
  bandLook,
} from "./band-node"
import type { BandData } from "./band-node"

// A layer band as the owner's reference draws them: a light grey row with
// its title centred across the top, a pastel side band with a big label
// reading bottom to top - behind the cards, grabbed only by its title.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = ResizeObserverStub
})
afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

function renderBand(data: Partial<BandData>, selected = false) {
  const props = {
    id: "band:b1",
    data: { label: "Spine-lag", color: null, orient: "h", ...data },
    selected,
  } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <BandNode {...props} />
    </ReactFlowProvider>
  )
}

describe("BandNode", () => {
  /** A band node on a real canvas, where its title chip has a layer. */
  async function onCanvas(data: Partial<BandData>, selected = false) {
    const node: Node = {
      id: "band:b1",
      type: "band",
      position: { x: 100, y: 50 },
      width: 800,
      height: 200,
      selected,
      data: { label: "Spine-lag", color: null, orient: "h", ...data },
    }
    const out = render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={[node]} nodeTypes={{ band: BandNode }} />
        </ReactFlowProvider>
      </div>
    )
    await settle()
    return out
  }

  it("draws a row with its title centred across the top, over the cables", async () => {
    const { container } = await onCanvas({})
    const grip = container.querySelector(`.${BAND_DRAG_HANDLE}`) as HTMLElement
    expect(grip.style.height).toBe(`${BAND.TITLE}px`)
    expect(grip.className).toMatch(/pointer-events-auto/)
    // The title is a chip in the edge-label layer (above the cables, under
    // the cards), centred on the strip.
    const title = container.querySelector(
      ".react-flow__edgelabel-renderer .band-title"
    ) as HTMLElement
    expect(title.textContent).toBe("Spine-lag")
    expect(title.style.transform).toBe(
      `translate(-50%, -50%) translate(${100 + 400}px, ${50 + BAND.TITLE / 2}px)`
    )
    const body = container.querySelector("[data-band]") as HTMLElement
    expect(body.dataset.band).toBe("h")
    // Neutral: the theme's grey, the same on the chip, never a literal.
    expect(body.className).toContain("var(--muted)")
    expect(title.className).toContain("var(--muted)")
    // A band is a region, not a status: no dot, no pill.
    expect(container.querySelector(".band-body .rounded-full")).toBeNull()
  })

  it("draws a side band's big label reading bottom to top", () => {
    const { container } = renderBand({
      label: "WAN",
      orient: "v",
      color: ZONE_COLORS[1],
    })
    const grip = container.querySelector(`.${BAND_DRAG_HANDLE}`) as HTMLElement
    // The whole strip is the grip.
    expect(grip.className).toMatch(/h-full w-full/)
    const turned = screen.getByText("WAN").parentElement as HTMLElement
    expect(turned.className).toMatch(/writing-mode:vertical-rl/)
    expect(turned.className).toMatch(/rotate-180/)
    expect(screen.getByText("WAN").className).toMatch(/text-\[20px\]/)
    const body = container.querySelector("[data-band]") as HTMLElement
    expect(body.style.background).toContain(ZONE_COLORS[1])
  })

  it("renames on double-click, Enter to keep", () => {
    const onRename = vi.fn()
    const { container } = renderBand({ onRename })
    fireEvent.doubleClick(
      container.querySelector(`.${BAND_DRAG_HANDLE}`) as HTMLElement
    )
    const input = screen.getByDisplayValue("Spine-lag")
    fireEvent.change(input, { target: { value: "CE-lag" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith("CE-lag")
  })

  it("tints only with a zone swatch", () => {
    expect(bandLook(null).className).toContain("var(--muted)")
    expect(bandLook("#123456")).toEqual(bandLook(null))
    expect(String(bandLook(ZONE_COLORS[2]).style.background)).toContain(
      ZONE_COLORS[2]
    )
  })

  it("offers rename, swatches, up, down and delete when selected", async () => {
    const data: BandData = {
      label: "Leaf-lag",
      color: null,
      orient: "h",
      onRecolor: vi.fn(),
      onMove: vi.fn(),
      onDelete: vi.fn(),
    }
    const node: Node = {
      id: "band:b1",
      type: "band",
      position: { x: 0, y: 0 },
      width: 800,
      height: 200,
      selected: true,
      data,
    }
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={[node]} nodeTypes={{ band: BandNode }} />
        </ReactFlowProvider>
      </div>
    )
    await settle()
    fireEvent.click(screen.getByRole("button", { name: "Move up" }))
    fireEvent.click(screen.getByRole("button", { name: "Move down" }))
    expect(data.onMove).toHaveBeenNthCalledWith(1, -1)
    expect(data.onMove).toHaveBeenNthCalledWith(2, 1)
    fireEvent.click(screen.getByRole("button", { name: "Neutral" }))
    expect(data.onRecolor).toHaveBeenCalledWith(null)
    // Each swatch is named, and none reads as the neutral grey.
    fireEvent.click(screen.getByRole("button", { name: "Amber" }))
    expect(data.onRecolor).toHaveBeenCalledWith(ZONE_COLORS[3])
    const slate = screen.getByRole("button", { name: "Slate" })
    expect(slate.getAttribute("data-tip")).toBe("Slate")
    expect(slate.style.background).toContain("40%")
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(data.onDelete).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy()
  })
})

describe("a band of several layers", () => {
  const ACCESS = { id: "r-access", name: "Access", color: "#0ea5e9" }
  const SERVER = { id: "r-server", name: "Server", color: "#10b981" }

  beforeEach(() => {
    // cmdk scrolls the active option into view.
    Element.prototype.scrollIntoView ??= () => undefined
  })

  const Card = () => <div />
  const cardNode = (
    id: string,
    x: number,
    y: number,
    role: typeof ACCESS | null,
    type?: { id: string; name: string }
  ): Node => ({
    id,
    type: "card",
    position: { x, y },
    width: 120,
    height: 60,
    data: {
      device_id: id,
      role,
      ...(type ? { device_type_id: type.id, device_type: type.name } : {}),
    },
  })

  /** A band and cards on a real canvas: the band reads them from the
   * flow's store. */
  async function onCanvas(data: Partial<BandData>, extra: Node[] = []) {
    const band: Node = {
      id: "band:fab",
      type: "band",
      position: { x: 0, y: 0 },
      width: 800,
      height: 400,
      selected: true,
      data: { label: "Data Center fabric", color: null, orient: "h", ...data },
    }
    const out = render(
      <div style={{ width: 900, height: 700 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={[
              band,
              ...extra,
              cardNode("a1", 100, 80, ACCESS, { id: "t-1", name: "N9K" }),
              cardNode("a2", 400, 80, ACCESS),
              cardNode("s1", 100, 220, SERVER),
              cardNode("s2", 400, 220, SERVER),
            ]}
            nodeTypes={{ band: BandNode, card: Card }}
          />
        </ReactFlowProvider>
      </div>
    )
    await settle()
    return out
  }

  it("labels each sub-row with its role's badge, a rule between them", async () => {
    const { container } = await onCanvas({
      layout: "stack",
      rule: { by: "role", ids: [ACCESS.id, SERVER.id] },
    })
    const labels = [
      ...container.querySelectorAll<HTMLElement>(
        ".react-flow__edgelabel-renderer .band-sublabel"
      ),
    ]
    expect(labels.map((l) => l.textContent)).toEqual(["Access", "Server"])
    // At the band's left, level with the middle of the sub-row's cards.
    expect(labels[0].style.transform).toBe(
      `translate(0, -50%) translate(${BAND.SUB_EDGE}px, 110px)`
    )
    expect(labels[1].style.transform).toContain("250px")
    // The role's badge, never a dot.
    const badge = labels[0].firstElementChild as HTMLElement
    expect(badge.style.backgroundColor).toBe("rgb(14, 165, 233)")
    expect(container.querySelector(".band-sublabel .rounded-full")).toBeNull()
    // One rule, halfway between the sub-rows.
    const rules = container.querySelectorAll<HTMLElement>(".band-divider")
    expect(rules).toHaveLength(1)
    expect(rules[0].style.top).toBe("180px")
  })

  it("draws no sub-rows in one row", async () => {
    const { container } = await onCanvas({
      layout: "row",
      rule: { by: "role", ids: [ACCESS.id, SERVER.id] },
    })
    expect(container.querySelector(".band-sublabel")).toBeNull()
    expect(container.querySelector(".band-divider")).toBeNull()
  })

  it("switches between sub-rows and one row", async () => {
    const onLayout = vi.fn()
    await onCanvas({
      layout: "stack",
      rule: { by: "role", ids: [ACCESS.id, SERVER.id] },
      onLayout,
    })
    const sub = screen.getByRole("button", { name: "Sub-rows" })
    const one = screen.getByRole("button", { name: "One row" })
    expect(sub.getAttribute("aria-pressed")).toBe("true")
    expect(one.getAttribute("aria-pressed")).toBe("false")
    expect(one.getAttribute("data-tip")).toBe("One row")
    fireEvent.click(one)
    expect(onLayout).toHaveBeenCalledWith("row")
  })

  it("offers the layout only with several layers", async () => {
    await onCanvas({ rule: { by: "role", ids: [ACCESS.id] } })
    expect(screen.queryByRole("button", { name: "One row" })).toBeNull()
    expect(screen.getByRole("button", { name: "Layers…" })).toBeTruthy()
  })

  it("picks its layers from the roles and types on the map", async () => {
    const onLayers = vi.fn()
    const other: Node = {
      id: "band:srv",
      type: "band",
      position: { x: 0, y: 500 },
      width: 800,
      height: 160,
      data: {
        label: "Servers",
        color: null,
        orient: "h",
        rule: { by: "role", ids: [SERVER.id] },
      },
    }
    await onCanvas({ rule: { by: "role", ids: [ACCESS.id] }, onLayers }, [
      other,
    ])
    fireEvent.click(screen.getByRole("button", { name: "Layers…" }))
    await settle()
    const options = screen.getAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual([
      "Access",
      // Held by another band: named beside it.
      "ServerServers",
    ])
    expect(options[0].getAttribute("data-checked")).toBe("true")
    // Each role as its badge.
    const badge = options[1].querySelector("[data-slot=badge]") as HTMLElement
    expect(badge.textContent).toBe("Server")
    fireEvent.click(options[1])
    expect(onLayers).toHaveBeenLastCalledWith("role", [ACCESS.id, SERVER.id])
    fireEvent.click(options[0])
    expect(onLayers).toHaveBeenLastCalledWith("role", [])
    // Device types instead: a pick starts the band's layers afresh.
    fireEvent.click(screen.getByRole("button", { name: "Types" }))
    await settle()
    const types = screen.getAllByRole("option")
    expect(types.map((o) => o.textContent)).toEqual(["N9K"])
    fireEvent.click(types[0])
    expect(onLayers).toHaveBeenLastCalledWith("device_type", ["t-1"])
  })
})

describe("bands on the canvas", () => {
  const band = (id: string, orient: "h" | "v", x: number): Zone => ({
    id,
    kind: "band",
    orient,
    label: id,
    color: null,
    x,
    y: 0,
    w: orient === "v" ? 72 : 900,
    h: 400,
  })

  it("draws bands behind the cards, side bands first, click-through", async () => {
    const zones: Zone[] = [
      {
        id: "z",
        label: "Lab",
        color: ZONE_COLORS[0],
        x: 0,
        y: 0,
        w: 100,
        h: 100,
      },
      band("row", "h", 0),
      band("side", "v", 920),
    ]
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas graph={fanoutGraph} nodeStyle="diagram" zones={zones} />
      </div>
    )
    await settle()
    const order = [...container.querySelectorAll(".react-flow__node")].map(
      (n) => n.getAttribute("data-id")
    )
    // Side bands, then rows, then zones, then the cards: array order is
    // paint order.
    expect(order.slice(0, 3)).toEqual(["band:side", "band:row", "zone:z"])
    expect(order.length).toBeGreaterThan(3)
    const row = container.querySelector('[data-id="band:row"]') as HTMLElement
    expect(row.style.pointerEvents).toBe("none")
    for (const c of BAND_NODE_CLASS.split(" "))
      expect(row.classList.contains(c)).toBe(true)
  })
})
