// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { TopoNode, TopologyGraph } from "@/lib/api"
import { NO_TOPO_HIDDEN } from "./hidden"
import type { TopoHidden } from "./hidden"
import { TopologyObjectsSidebar } from "./map-sidebar"

// The Objects sidebar lists the map's cables under "Cables", each family
// with its eye and each cable with its own - the one a line hidden from
// its right-click menu comes back by.

const apiMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

beforeEach(() => {
  // The folds remember their state per browser.
  localStorage.clear()
  apiMock.mockReset()
  apiMock.mockImplementation(() => Promise.resolve({ results: [] }))
})
afterEach(cleanup)

const dev = (id: string): TopoNode => ({
  id: `dev:${id}`,
  type: "device",
  data: { name: id, device_id: id, role: { name: "Access", color: "" } },
})

const graph: TopologyGraph = {
  nodes: [dev("core"), dev("sw1")],
  edges: [
    {
      id: "e:c1:core:sw1",
      source: "dev:core",
      target: "dev:sw1",
      type: "cable",
      data: { cable_id: "c1", cable_type: "cat6", cable_numid: 7 },
    },
  ],
}

function sidebar(hidden: TopoHidden = NO_TOPO_HIDDEN) {
  const onHiddenChange = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TopologyObjectsSidebar
        graph={graph}
        checks={{}}
        zones={undefined}
        hidden={hidden}
        onHiddenChange={onHiddenChange}
        selectedDeviceId={null}
        selectedGroupId={null}
        selectedEdgeId={null}
        onPickNode={vi.fn()}
        onPickGroup={vi.fn()}
        onDrillGroup={vi.fn()}
        onPickEdge={vi.fn()}
        onFocusZone={vi.fn()}
        onRenameZone={vi.fn()}
      />
    </QueryClientProvider>
  )
  return { onHiddenChange }
}

describe("the Objects sidebar's cables", () => {
  it("are listed under Cables", () => {
    sidebar()
    expect(screen.getByText("Cables")).toBeTruthy()
    expect(screen.queryByText("Links")).toBeNull()
  })

  it("hide and show one cable by its own eye", () => {
    const { onHiddenChange } = sidebar()
    // The family folds shut by default.
    fireEvent.click(screen.getByText("cat6"))
    fireEvent.click(screen.getByRole("button", { name: "Hide core ↔ sw1" }))
    expect(onHiddenChange).toHaveBeenCalledWith({
      ...NO_TOPO_HIDDEN,
      edges: ["e:c1:core:sw1"],
    })
  })

  it("bring back a cable hidden from its menu", () => {
    const { onHiddenChange } = sidebar({
      ...NO_TOPO_HIDDEN,
      edges: ["e:c1:core:sw1"],
    })
    fireEvent.click(screen.getByText("cat6"))
    fireEvent.click(screen.getByRole("button", { name: "Show core ↔ sw1" }))
    expect(onHiddenChange).toHaveBeenCalledWith(NO_TOPO_HIDDEN)
  })
})
