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

function sidebar(hidden: TopoHidden = NO_TOPO_HIDDEN, g = graph) {
  const onHiddenChange = vi.fn()
  const onPickNode = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TopologyObjectsSidebar
        graph={g}
        checks={{}}
        zones={undefined}
        hidden={hidden}
        onHiddenChange={onHiddenChange}
        selectedDeviceId={null}
        selectedGroupId={null}
        selectedEdgeId={null}
        onPickNode={onPickNode}
        onPickGroup={vi.fn()}
        onDrillGroup={vi.fn()}
        onPickEdge={vi.fn()}
        onFocusZone={vi.fn()}
        onRenameZone={vi.fn()}
      />
    </QueryClientProvider>
  )
  return { onHiddenChange, onPickNode }
}

// The provider networks a map's circuits meet at (#466).
const network: TopoNode = {
  id: "pn:pn1",
  type: "provider_network",
  data: {
    kind: "provider_network",
    provider_network_id: "pn1",
    name: "MPLS cloud",
    provider: { id: "p1", name: "Telco" },
    circuit_count: 2,
    circuits: [],
  },
}
const withNetwork: TopologyGraph = {
  nodes: [...graph.nodes, network],
  edges: [
    ...graph.edges,
    {
      id: "ce:c9",
      source: "dev:core",
      target: "pn:pn1",
      type: "circuit",
      data: { circuit: { id: "c9", cid: "C-9" } as never },
    },
  ],
}

describe("the Objects sidebar's provider networks", () => {
  it("are listed with their provider, never as a device or a cable", () => {
    sidebar(NO_TOPO_HIDDEN, withNetwork)
    expect(
      screen.getByText("Provider networks", { selector: "h3, div, span" })
    ).toBeTruthy()
    expect(screen.getByText("MPLS cloud")).toBeTruthy()
    expect(screen.getByText("Telco")).toBeTruthy()
    // One family under Cables: the circuit is not a cable.
    fireEvent.click(screen.getByText("cat6"))
    expect(screen.queryByText("core ↔ MPLS cloud")).toBeNull()
  })

  it("hide all with the group's eye, one with its row's", () => {
    const { onHiddenChange, onPickNode } = sidebar(NO_TOPO_HIDDEN, withNetwork)
    fireEvent.click(
      screen.getByRole("button", { name: "Hide Provider networks" })
    )
    expect(onHiddenChange).toHaveBeenLastCalledWith({
      ...NO_TOPO_HIDDEN,
      kinds: ["Provider networks"],
    })
    fireEvent.click(screen.getByRole("button", { name: "Hide MPLS cloud" }))
    expect(onHiddenChange).toHaveBeenLastCalledWith({
      ...NO_TOPO_HIDDEN,
      devices: ["pn:pn1"],
    })
    fireEvent.click(screen.getByText("MPLS cloud"))
    expect(onPickNode).toHaveBeenCalledWith(network)
  })
})

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

// A circuit between two of the map's devices, both ends cabled.
const withCircuit: TopologyGraph = {
  nodes: graph.nodes,
  edges: [
    ...graph.edges,
    {
      id: "cc:c9",
      source: "dev:core",
      target: "dev:sw1",
      type: "circuit",
      data: {
        circuit: {
          id: "c9",
          cid: "MPLS-9",
          provider: { name: "Telco" },
        } as never,
        ends: [{ side: "A" }, { side: "Z" }] as never,
      },
    },
  ],
}

describe("the Objects sidebar's circuits", () => {
  it("lists them by cid under Circuits, never as a cable", () => {
    sidebar(NO_TOPO_HIDDEN, withCircuit)
    expect(screen.getByText("MPLS-9")).toBeTruthy()
    fireEvent.click(screen.getByText("cat6"))
    expect(screen.getAllByText("core ↔ sw1")).toHaveLength(2)
  })

  it("hide all with the group's eye, one with its row's", () => {
    const { onHiddenChange } = sidebar(NO_TOPO_HIDDEN, withCircuit)
    fireEvent.click(screen.getByRole("button", { name: "Hide Circuits" }))
    expect(onHiddenChange).toHaveBeenLastCalledWith({
      ...NO_TOPO_HIDDEN,
      kinds: ["Circuits"],
    })
    fireEvent.click(screen.getByRole("button", { name: "Hide MPLS-9" }))
    expect(onHiddenChange).toHaveBeenLastCalledWith({
      ...NO_TOPO_HIDDEN,
      edges: ["cc:c9"],
    })
  })
})
