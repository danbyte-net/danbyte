// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TopologyGraph } from "@/lib/api"
import { TopologyCanvas } from "./topology-canvas"

// A virtual chassis' stack on the live canvas: clicking it selects the
// frame for its own toolbar, never as a device (no panel, no spotlight).

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
// The router restores the scroll on navigation; jsdom has no layout.
window.scrollTo = () => undefined

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const VC = { id: "vc1", name: "stack1" }
const member = (id: string, position: number) => ({
  id: `dev:${id}`,
  type: "device",
  data: {
    device_id: id,
    name: id,
    role: { name: "Access", color: "#2563eb" },
    vc: { ...VC, position, master: position === 1 },
  },
})
const GRAPH = {
  nodes: [member("sw1", 1), member("sw2", 2)],
  edges: [],
} as unknown as TopologyGraph

async function renderMap(onSelectNode: () => void) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => (
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          graph={GRAPH}
          nodeStyle="diagram"
          chassis={{ mode: "v" }}
          onSelectNode={onSelectNode}
        />
      </div>
    ),
  })
  const router = createRouter({
    routeTree: root.addChildren([map]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  const view = render(<RouterProvider router={router} />)
  await settle()
  return view
}

describe("a stack on the canvas", () => {
  it("is selected for its toolbar, never as a device", async () => {
    const onSelectNode = vi.fn()
    const { container } = await renderMap(onSelectNode)
    const frame = container.querySelector<HTMLElement>(
      ".react-flow__node-chassis"
    )
    expect(frame).toBeTruthy()
    fireEvent.click(frame!)
    await settle()
    expect(onSelectNode).not.toHaveBeenCalled()
    // A member still opens as the device it is.
    fireEvent.click(
      container.querySelector<HTMLElement>('[data-id="dev:sw1"]')!
    )
    expect(onSelectNode).toHaveBeenCalledWith(
      expect.objectContaining({ device_id: "sw1" })
    )
  })
})
