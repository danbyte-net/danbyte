// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { ReactFlowProvider } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { afterEach, describe, expect, it } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { approxMeasure } from "@/lib/diagram/measure"
import { buildDiagram } from "./diagram/build-diagram"
import { NODE_KINDS, PLAIN, sizeOf } from "./node-registry"
import { PortNode, portSize } from "./port-node"

// A graph that names ports - the port-level trace graph - draws each as a
// neutral card the Diagram lays out at its own size. The trace maps draw
// the device-level graph instead, where a patch panel is a card with a nub
// per port (diagram/build-diagram.test.ts).

afterEach(cleanup)

function renderPort(data: object, selected = false) {
  const props = { id: "p", data, selected } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <PortNode {...props} />
    </ReactFlowProvider>
  )
}

describe("PortNode", () => {
  it("names the port over its device and kind, at its own size", () => {
    const d = { name: "front1", kind: "front_port", device_name: "pp-01" }
    const { container } = renderPort(d)
    expect(screen.getByText("front1")).toBeTruthy()
    expect(screen.getByText("pp-01 · front port")).toBeTruthy()
    const box = container.querySelector<HTMLElement>("[data-port-node]")!
    const { width, height } = portSize(d)
    expect(box.style.width).toBe(`${width}px`)
    expect(box.style.height).toBe(`${height}px`)
    expect(box.className).toContain("rounded-lg")
    expect(container.querySelector("[title]")).toBeNull()
  })

  it("is outlined when selected, as a Diagram card is", () => {
    const { container } = renderPort({ name: "eth0" }, true)
    const box = container.querySelector<HTMLElement>("[data-port-node]")!
    expect(box.className).toContain("outline-primary")
    expect(box.className).not.toMatch(/ring-/)
  })

  it("labels a splitter with the shared badge", () => {
    renderPort({ name: "IN", is_splitter: true })
    expect(screen.getByText("Splitter").dataset.slot).toBe("badge")
  })

  it("grows with a long name", () => {
    expect(portSize({ name: "Ethernet1/1/48" }).width).toBeGreaterThan(
      portSize({ name: "e1" }).width
    )
  })
})

describe("a port-level graph on the Diagram", () => {
  const graph: TopologyGraph = {
    nodes: [
      { id: "dev:a", type: "device", data: { name: "sw-01" } },
      {
        id: "if:a",
        type: "interface",
        data: { name: "Gi1/0/1", device_name: "sw-01" },
      },
      {
        id: "fp:1",
        type: "front_port",
        data: { name: "front1", device_name: "pp-01" },
      },
      {
        id: "rp:1",
        type: "rear_port",
        data: { name: "rear1", device_name: "pp-01" },
      },
      {
        id: "if:b",
        type: "interface",
        data: { name: "eth0", device_name: "srv-01" },
      },
    ],
    edges: [
      { id: "m1", source: "dev:a", target: "if:a", type: "membership" },
      {
        id: "c1",
        source: "if:a",
        target: "fp:1",
        type: "cable",
        data: { cable_id: "c1", marked: true },
      },
      { id: "t1", source: "fp:1", target: "rp:1", type: "through" },
      {
        id: "c2",
        source: "rp:1",
        target: "if:b",
        type: "cable",
        data: { cable_id: "c2", marked: true },
      },
    ],
  }

  it("lays each port out at its own box and draws every line", () => {
    const b = buildDiagram(graph, {
      mode: "detailed",
      line: "elbow",
      colorMode: "cable",
      measure: approxMeasure,
      sizeOf,
    })
    for (const id of ["if:a", "fp:1", "rp:1", "if:b"]) {
      const n = b.nodes.find((x) => x.id === id)!
      expect(n.type).not.toBe("card")
      expect(Object.keys(NODE_KINDS)).toContain(n.type)
      const s = sizeOf(n)
      expect(s).not.toEqual(PLAIN)
      expect([n.width, n.height]).toEqual([s.width, s.height])
      expect(Number.isFinite(n.position.x)).toBe(true)
      expect(Number.isFinite(n.position.y)).toBe(true)
    }
    expect(b.edges.map((e) => e.id).sort()).toEqual(["c1", "c2", "m1", "t1"])
    expect(b.edges.every((e) => e.type === "link")).toBe(true)
  })
})
