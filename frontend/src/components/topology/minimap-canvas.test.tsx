// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react"
import { MiniMap, ReactFlow, ReactFlowProvider, useStore } from "@xyflow/react"
import type { Node } from "@xyflow/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { MiniMapCanvas, NoMiniMapNode, miniMapFrame } from "./minimap-canvas"
import type { Frame } from "./minimap-canvas"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** A 2D context that only records what is drawn. */
function recorder() {
  const drawn: { fill: string; rect: number[] }[] = []
  const ctx = {
    fillStyle: "",
    setTransform: () => undefined,
    clearRect: () => undefined,
    beginPath: () => undefined,
    fill: () => undefined,
    fillRect(x: number, y: number, w: number, h: number) {
      drawn.push({ fill: ctx.fillStyle, rect: [x, y, w, h] })
    },
    roundRect(x: number, y: number, w: number, h: number) {
      drawn.push({ fill: ctx.fillStyle, rect: [x, y, w, h] })
    },
  }
  return { ctx, drawn }
}

let rec = recorder()
beforeEach(() => {
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = ResizeObserverStub
  rec = recorder()
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => rec.ctx as unknown as CanvasRenderingContext2D
  )
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const frames = () =>
  act(async () => {
    for (let i = 0; i < 3; i++)
      await new Promise((r) => requestAnimationFrame(() => r(null)))
  })

const grid = (count: number): Node[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    position: { x: (i % 10) * 260 - 400, y: Math.floor(i / 10) * 120 + 30 },
    width: 200,
    height: 80,
    data: { color: i % 2 ? "#aa0000" : "#0000aa" },
  }))

const colorOf = (n: Node) => (n.data as { color: string }).color

describe("miniMapFrame", () => {
  it("is the view box React Flow's MiniMap draws", async () => {
    let frame: Frame | null = null
    function Probe() {
      frame = useStore(miniMapFrame)
      return null
    }
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={grid(37)}
            edges={[]}
            defaultViewport={{ x: 120, y: -40, zoom: 0.7 }}
          >
            <MiniMap />
            <Probe />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    )
    await frames()
    const box = container
      .querySelector(".react-flow__minimap-svg")!
      .getAttribute("viewBox")!
      .split(" ")
      .map(Number)
    const f = frame as Frame | null
    expect(f && [f.x, f.y, f.width, f.height]).toEqual(box)
  })
})

describe("MiniMapCanvas", () => {
  it("paints every node once, in its colour, where the MiniMap draws none", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={grid(30)} edges={[]} fitView>
            <MiniMapCanvas nodeColor={colorOf} theme="light" />
            <MiniMap nodeColor={colorOf} nodeComponent={NoMiniMapNode} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    )
    await frames()
    expect(container.querySelectorAll(".react-flow__minimap-node").length).toBe(
      0
    )
    // Under the MiniMap: its panel comes first.
    const panels = [...container.querySelectorAll(".react-flow__panel")]
    const canvas = container.querySelector("canvas")!
    expect(panels.indexOf(canvas.parentElement!)).toBeLessThan(
      panels.indexOf(container.querySelector(".react-flow__minimap")!)
    )
    const last = rec.drawn.slice(-30)
    expect(last.length).toBe(30)
    expect(new Set(last.map((d) => d.fill))).toEqual(
      new Set(["rgb(0, 0, 170)", "rgb(170, 0, 0)"])
    )
    // Inside the minimap, and each card its own rect.
    for (const { rect } of last) {
      const [x, y, w, h] = rect
      expect(x).toBeGreaterThanOrEqual(0)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(x + w).toBeLessThanOrEqual(200 * devicePixelRatio)
      expect(y + h).toBeLessThanOrEqual(150 * devicePixelRatio)
    }
  })

  it("draws a card too small to see a device pixel across", async () => {
    // A site's width in cards: each far under a pixel in the minimap.
    const wide = grid(30).map((n, i) => ({
      ...n,
      position: { x: i * 40_000, y: (i % 3) * 30_000 },
      selected: i === 7,
    }))
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={wide} edges={[]} fitView>
            <MiniMapCanvas nodeColor={colorOf} theme="light" />
            <MiniMap nodeColor={colorOf} nodeComponent={NoMiniMapNode} />
          </ReactFlow>
        </ReactFlowProvider>
      </div>
    )
    await frames()
    const last = rec.drawn.slice(-30)
    expect(last.length).toBe(30)
    for (const [i, { rect }] of last.entries()) {
      const least = (i === 7 ? 2 : 1) - 1e-9
      expect(rect[2]).toBeGreaterThanOrEqual(least)
      expect(rect[3]).toBeGreaterThanOrEqual(least)
    }
  })
})
