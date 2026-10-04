// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { ReactFlow, ReactFlowProvider } from "@xyflow/react"
import type { Node } from "@xyflow/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ChassisNodeData } from "./build-diagram"
import { CHASSIS_DRAG_HANDLE, stripSide } from "./chassis"
import { ChassisActionsContext, ChassisNode, chassisTip } from "./chassis-node"
import type { ChassisActions } from "./chassis-node"

// A virtual chassis' stack on the canvas: its name strip down the left or
// across the top, the name a link to the chassis, and - selected - the
// toolbar that turns, unstacks or removes it.

afterEach(cleanup)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
window.scrollTo = () => undefined

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const data = (over: Partial<ChassisNodeData> = {}): ChassisNodeData => ({
  vc: { id: "vc1", name: "stack-01" },
  orient: "v",
  members: ["dev:a", "dev:b"],
  inner: 2,
  ...over,
  side: over.side ?? stripSide(over.orient ?? "v"),
})

async function onCanvas(
  d: ChassisNodeData,
  selected = false,
  actions: ChassisActions | null = null
) {
  const node: Node = {
    id: "vc:vc1",
    type: "chassis",
    position: { x: 100, y: 100 },
    width: 200,
    height: 120,
    selected,
    data: d,
  }
  const root = createRootRoute({ component: () => <Outlet /> })
  const map = createRoute({
    getParentRoute: () => root,
    path: "/topology",
    component: () => (
      <div style={{ width: 800, height: 600 }}>
        <ChassisActionsContext.Provider value={actions}>
          <ReactFlowProvider>
            <ReactFlow nodes={[node]} nodeTypes={{ chassis: ChassisNode }} />
          </ReactFlowProvider>
        </ChassisActionsContext.Provider>
      </div>
    ),
  })
  const vcPage = createRoute({
    getParentRoute: () => root,
    path: "/virtual-chassis/$id",
    component: () => <p>chassis page</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([map, vcPage]),
    history: createMemoryHistory({ initialEntries: ["/topology"] }),
  })
  render(<RouterProvider router={router as never} />)
  await screen.findByText("stack-01")
  await settle()
  return router
}

describe("ChassisNode", () => {
  it("names the chassis on a strip down its left side, a link to it", async () => {
    const router = await onCanvas(data())
    const name = screen.getByRole("link", { name: "stack-01" })
    const strip = name.closest(`.${CHASSIS_DRAG_HANDLE}`) as HTMLElement
    expect(strip.className).toContain("left-0")
    expect(strip.getAttribute("data-tip")).toBe(
      "2 members · 2 cables between them"
    )
    fireEvent.click(name)
    await settle()
    expect(router.state.location.pathname).toBe("/virtual-chassis/vc1")
  })

  it("puts the strip across the top of a left-to-right stack", async () => {
    await onCanvas(data({ orient: "h" }))
    const strip = screen
      .getByRole("link", { name: "stack-01" })
      .closest(`.${CHASSIS_DRAG_HANDLE}`) as HTMLElement
    expect(strip.className).toContain("top-0")
  })

  it("turns, unstacks and removes from its toolbar when selected", async () => {
    const actions: ChassisActions = {
      onOrient: vi.fn(),
      onSide: vi.fn(),
      onUnstack: vi.fn(),
      onRemove: vi.fn(),
      placed: () => true,
    }
    await onCanvas(data(), true, actions)
    expect(
      screen
        .getByRole("button", { name: "Top-down" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Left-right" }))
    fireEvent.click(screen.getByRole("button", { name: "Unstack" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove from map" }))
    expect(actions.onOrient).toHaveBeenCalledWith("vc1", "h")
    expect(actions.onUnstack).toHaveBeenCalledWith("vc1")
    expect(actions.onRemove).toHaveBeenCalledWith("vc1")
    expect(
      screen.getByRole("link", { name: "Open virtual chassis" })
    ).toBeTruthy()
  })

  it("moves its name to the side picked in its toolbar", async () => {
    const actions: ChassisActions = {
      onOrient: vi.fn(),
      onSide: vi.fn(),
      onUnstack: vi.fn(),
    }
    await onCanvas(data({ side: "R" }), true, actions)
    const strip = screen
      .getByRole("link", { name: "stack-01" })
      .closest(`.${CHASSIS_DRAG_HANDLE}`) as HTMLElement
    expect(strip.className).toContain("right-0")
    expect(
      screen
        .getByRole("button", { name: "Name on right" })
        .getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Name at bottom" }))
    expect(actions.onSide).toHaveBeenCalledWith("vc1", "B")
  })

  it("lays a name at the bottom level, not up the side", async () => {
    await onCanvas(data({ side: "B" }))
    const strip = screen
      .getByRole("link", { name: "stack-01" })
      .closest(`.${CHASSIS_DRAG_HANDLE}`) as HTMLElement
    expect(strip.className).toContain("bottom-0")
    expect(strip.innerHTML).not.toContain("vertical-rl")
  })

  it("offers Remove only for a chassis placed on the map", async () => {
    await onCanvas(data(), true, {
      onOrient: vi.fn(),
      onSide: vi.fn(),
      onUnstack: vi.fn(),
    })
    expect(screen.queryByRole("button", { name: "Remove from map" })).toBeNull()
  })

  it("says how many members and inner cables it has", () => {
    expect(chassisTip({ members: ["a"], inner: 0 })).toBe("1 member")
    expect(chassisTip({ members: ["a", "b"], inner: 1 })).toBe(
      "2 members · 1 cable between them"
    )
  })
})
