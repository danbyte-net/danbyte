// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { Handle, Position, ReactFlow, ReactFlowProvider } from "@xyflow/react"
import type { Edge, Node } from "@xyflow/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { presized } from "./presize"

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

const card = (id: string, x: number, y: number, extra = {}): Node => ({
  id,
  type: "card",
  position: { x, y },
  width: 200,
  height: 80,
  data: {},
  ...extra,
})

describe("presized", () => {
  it("gives a card its box and a handle at the middle of top and bottom", () => {
    const n = presized(card("a", 0, 0))
    expect(n.measured).toEqual({ width: 200, height: 80 })
    expect(n.handles).toEqual([
      {
        id: null,
        type: "target",
        position: Position.Top,
        x: 99.5,
        y: -0.5,
        width: 1,
        height: 1,
      },
      {
        id: null,
        type: "source",
        position: Position.Bottom,
        x: 99.5,
        y: 79.5,
        width: 1,
        height: 1,
      },
    ])
  })

  it("gives a junction its handles left and right", () => {
    const n = presized({
      id: "j",
      type: "junction",
      position: { x: 0, y: 0 },
      width: 8,
      height: 8,
      data: {},
    })
    expect(n.handles?.map((h) => [h.type, h.position, h.x, h.y])).toEqual([
      ["target", Position.Left, -0.5, 3.5],
      ["source", Position.Right, 7.5, 3.5],
    ])
  })

  it("leaves photos, hidden, unsized and other nodes to be measured", () => {
    const photo = card("p", 0, 0, { data: { diagram: { photo: {} } } })
    const hidden = card("h", 0, 0, { hidden: true })
    const unsized: Node = {
      id: "u",
      type: "card",
      position: { x: 0, y: 0 },
      data: {},
    }
    const zone = { ...card("z", 0, 0), type: "zone" }
    for (const n of [photo, hidden, unsized, zone]) expect(presized(n)).toBe(n)
  })

  it("is the same node once done, and redone for a new size", () => {
    const once = presized(card("a", 0, 0))
    expect(presized(once)).toBe(once)
    const grown = presized({ ...once, width: 260 })
    expect(grown.measured).toEqual({ width: 260, height: 80 })
    expect(grown.handles?.[0].x).toBe(129.5)
  })
})

// What it is for: React Flow mounts only the presized cards in view, where
// it would mount every card it has not measured - and the edges between
// cards in view still draw.
describe("React Flow with presized cards", () => {
  function Probe() {
    return (
      <div data-probe style={{ width: 200, height: 80 }}>
        <Handle type="target" position={Position.Top} />
        <Handle type="source" position={Position.Bottom} />
      </div>
    )
  }
  const nodeTypes = { card: Probe }
  const map = (nodes: Node[], edges: Edge[] = []) =>
    render(
      <div style={{ width: 500, height: 500 }}>
        <ReactFlowProvider>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onlyRenderVisibleElements
          />
        </ReactFlowProvider>
      </div>
    )
  const far = Array.from({ length: 40 }, (_, i) =>
    card(`far${i}`, 5000 + i * 300, 5000)
  )
  const near = [card("a", 10, 10), card("b", 10, 200)]
  const edges: Edge[] = [{ id: "a-b", source: "a", target: "b" }]

  it("mounts every card it has not measured", () => {
    const { container } = map([...near, ...far], edges)
    expect(container.querySelectorAll("[data-probe]").length).toBe(42)
  })

  it("mounts only the presized cards in view", () => {
    const { container } = map([...near, ...far].map(presized), edges)
    expect(container.querySelectorAll("[data-probe]").length).toBe(2)
    expect(container.querySelectorAll(".react-flow__edge").length).toBe(1)
  })
})
