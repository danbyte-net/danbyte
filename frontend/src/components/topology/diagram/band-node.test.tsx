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
    fireEvent.click(screen.getAllByRole("button", { name: "Tint" })[3])
    expect(data.onRecolor).toHaveBeenCalledWith(ZONE_COLORS[3])
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(data.onDelete).toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy()
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
