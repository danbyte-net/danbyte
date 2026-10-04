// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { fanoutGraph } from "./__fixtures__/fanout-graph"
import { CHASSIS_IDS_MIME, DEVICE_IDS_MIME } from "./diagram/placement"
import { TopologyCanvas } from "./topology-canvas"

// The canvas as a drop target: a map built by hand takes device ids
// dragged in from the palette, and stays a live canvas while empty.

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

const EMPTY: TopologyGraph = { nodes: [], edges: [] }

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

function drag(ids: unknown, types = [DEVICE_IDS_MIME]) {
  return {
    dataTransfer: {
      types,
      dropEffect: "none",
      getData: (k: string) => (types.includes(k) ? JSON.stringify(ids) : ""),
    },
    clientX: 120,
    clientY: 80,
  }
}

describe("canvas drop target", () => {
  it("draws an empty map built by hand, with its empty state", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={vi.fn()}
          emptyState={<p>No devices yet.</p>}
        />
      </div>
    )
    await settle()
    expect(screen.getByText("No devices yet.")).toBeTruthy()
    expect(container.querySelector(".react-flow")).toBeTruthy()
  })

  it("keeps the plain empty message on a map that takes no drops", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas graph={EMPTY} nodeStyle="diagram" />
      </div>
    )
    await settle()
    expect(screen.getByText("No cabled devices yet.")).toBeTruthy()
    expect(container.querySelector(".react-flow")).toBeNull()
  })

  it("hands dropped device ids over with the canvas point", async () => {
    const onDrop = vi.fn()
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={onDrop}
          emptyState={<p>No devices yet.</p>}
        />
      </div>
    )
    await settle()
    const target = container.querySelector<HTMLElement>(".react-flow")!
    const over = drag(["a", "b"])
    // Only a device drag is accepted: the drop effect says copy.
    const accepted = !fireEvent.dragOver(target, over)
    expect(accepted).toBe(true)
    expect(over.dataTransfer.dropEffect).toBe("copy")
    fireEvent.drop(target, drag(["a", "b", "a"]))
    expect(onDrop).toHaveBeenCalledTimes(1)
    const [ids, at] = onDrop.mock.calls[0] as [
      string[],
      { x: number; y: number },
    ]
    expect(ids).toEqual(["a", "b"])
    expect(typeof at.x).toBe("number")
    expect(typeof at.y).toBe("number")
    // Dropped on the empty state card itself: still the canvas's drop.
    fireEvent.drop(screen.getByText("No devices yet."), drag(["c"]))
    expect(onDrop).toHaveBeenCalledTimes(2)
  })

  it("hands dropped virtual chassis over to their own handler", async () => {
    const onDevices = vi.fn()
    const onChassis = vi.fn()
    const { container, rerender } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={onDevices}
          onDropChassis={onChassis}
        />
      </div>
    )
    await settle()
    const target = container.querySelector<HTMLElement>(".react-flow")!
    const over = drag(["vc-1"], [CHASSIS_IDS_MIME])
    expect(fireEvent.dragOver(target, over)).toBe(false)
    expect(over.dataTransfer.dropEffect).toBe("copy")
    fireEvent.drop(target, drag(["vc-1"], [CHASSIS_IDS_MIME]))
    expect(onChassis).toHaveBeenCalledTimes(1)
    expect(onChassis.mock.calls[0][0]).toEqual(["vc-1"])
    expect(onDevices).not.toHaveBeenCalled()
    // A map that places no chassis lets the drag pass.
    rerender(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={onDevices}
        />
      </div>
    )
    await settle()
    const plain = container.querySelector<HTMLElement>(".react-flow")!
    expect(fireEvent.dragOver(plain, drag(["vc-1"], [CHASSIS_IDS_MIME]))).toBe(
      true
    )
    fireEvent.drop(plain, drag(["vc-1"], [CHASSIS_IDS_MIME]))
    expect(onChassis).toHaveBeenCalledTimes(1)
    expect(onDevices).not.toHaveBeenCalled()
  })

  it("ignores other drags, and drops on a map that takes none", async () => {
    const onDrop = vi.fn()
    const { container, rerender } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={onDrop}
        />
      </div>
    )
    await settle()
    const target = container.querySelector<HTMLElement>(".react-flow")!
    expect(fireEvent.dragOver(target, drag(["a"], ["text/plain"]))).toBe(true)
    fireEvent.drop(target, drag("not a list"))
    expect(onDrop).not.toHaveBeenCalled()
    rerender(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas graph={fanoutGraph} nodeStyle="hierarchy" />
      </div>
    )
    await settle()
    const map = container.querySelector<HTMLElement>(".react-flow")!
    expect(fireEvent.dragOver(map, drag(["a"]))).toBe(true)
  })

  it("draws devices on their way muted where they will land", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="diagram"
          onDropDevices={vi.fn()}
          emptyState={<p>No devices yet.</p>}
          pending={[
            { id: "dev:a", name: "leaf1", color: "0ea5e9", at: [100, 50] },
          ]}
        />
      </div>
    )
    await settle()
    const card = container.querySelector<HTMLElement>('[data-pending="dev:a"]')!
    expect(card.textContent).toBe("leaf1")
    expect(card.className).toContain("opacity-50")
    expect(card.style.transform).toBe("translate(-20px, 14px)")
    // A card on its way is not an empty map.
    expect(screen.queryByText("No devices yet.")).toBeNull()
  })

  it("draws a Hierarchy card on its way at the size it asks for", async () => {
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={EMPTY}
          nodeStyle="hierarchy"
          onDropDevices={vi.fn()}
          pending={[
            {
              id: "dev:a",
              name: "leaf1",
              at: [100, 50],
              size: { w: 190, h: 130 },
            },
          ]}
        />
      </div>
    )
    await settle()
    const card = container.querySelector<HTMLElement>('[data-pending="dev:a"]')!
    expect(card.style.width).toBe("190px")
    expect(card.style.height).toBe("130px")
    expect(card.style.transform).toBe("translate(5px, -15px)")
  })
})
