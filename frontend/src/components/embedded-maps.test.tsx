// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CableTraceDialog } from "./cable-trace-dialog"
import { IncompleteBadge, PathStrip, traceUrl } from "./cable-trace-path"
import { DeviceMiniTopology } from "./device-mini-topology"
import { DevicePathsList } from "./device-paths-list"
import { InterfaceTraceDialog } from "./interface-trace-dialog"
import { TraceSection } from "./topology/trace-section"
import { TunnelMap } from "./tunnels/tunnel-map"
import { VmTopologyCard } from "./vm-topology-card"

import type { DevicePathRun, Tunnel, TraceGraph } from "@/lib/api"

// The maps other pages embed - a device's Topology card and its runs, the
// trace section and dialogs, a tunnel's map, a VM's Topology card - speak
// the topology page's words and use its loading, empty and badge parts.

const { apiMock, canvasProps } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  canvasProps: [] as Record<string, unknown>[],
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))
// React Flow has no layout to measure in jsdom; the canvas is not what
// these tests are about - only what it is asked to draw.
vi.mock("@/components/topology/topology-canvas", () => ({
  TopologyCanvas: (props: Record<string, unknown>) => {
    canvasProps.push(props)
    return <div data-testid="canvas" />
  },
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

/** What the stubbed API answers, by path prefix. A missing entry never
 * resolves, so the component under test stays loading. */
let answers: Record<string, unknown> = {}
beforeEach(() => {
  answers = {}
  canvasProps.length = 0
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

/** Mount inside a real in-memory router (the parts link and navigate) and
 * a fresh query cache. */
function mount(ui: React.ReactNode, at = "/here") {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/here",
    component: () => <>{ui}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

const node = (id: string, device: string, name: string) => ({
  id,
  type: "port",
  position: { x: 0, y: 0 },
  data: { name, device_name: device, device_id: `dev-${device}` },
})

/** sw-01 ge-0/0/1 ─cat6─ srv-01 eth0: a run the flat strip can draw. */
function linear(complete: boolean): TraceGraph {
  return {
    nodes: [node("if:a", "sw-01", "ge-0/0/1"), node("if:b", "srv-01", "eth0")],
    edges: [
      {
        id: "e1",
        source: "if:a",
        target: "if:b",
        type: "cable",
        data: { cable_id: "c1", cable_type: "cat6" },
      },
    ],
    origin: { type: "cable", id: "c1" },
    complete,
    device_graph: { nodes: [], edges: [] },
  } as unknown as TraceGraph
}

/** A trace with nothing on the far side: the port and its own device. */
const UNCABLED = {
  nodes: [node("if:a", "sw-01", "ge-0/0/1"), node("dev:1", "sw-01", "sw-01")],
  edges: [],
  origin: { type: "interface", id: "i1" },
  complete: true,
  device_graph: { nodes: [node("dev:1", "sw-01", "sw-01")], edges: [] },
} as unknown as TraceGraph

const run = (complete: boolean): DevicePathRun => ({
  origin: { name: "ge-0/0/1", kind: "interface" },
  steps: [
    {
      t: "chip",
      device_id: "d1",
      device: "sw-01",
      ports: [{ name: "ge-0/0/1", interface_id: "i1" }],
      panel: false,
    },
    {
      t: "seg",
      cable_id: "c1",
      cable_numid: 1,
      label: "cat6",
      cable_label: null,
      color: null,
    },
    {
      t: "chip",
      device_id: "d2",
      device: "srv-01",
      ports: [{ name: "eth0", interface_id: "i2" }],
      panel: false,
    },
  ],
  complete,
})

describe("IncompleteBadge", () => {
  it("is the warning badge, in sentence case", () => {
    render(<IncompleteBadge />)
    const b = screen.getByText("Incomplete")
    expect(b.getAttribute("data-variant")).toBe("warning")
  })
})

describe("TraceSection", () => {
  it("is headed Trace, with the Diagram's axis words", async () => {
    answers["/api/t/"] = {
      ...linear(false),
      device_graph: {
        nodes: [node("dev:1", "sw-01", "sw-01"), node("dev:2", "b", "b")],
        edges: [],
      },
    }
    mount(<TraceSection url="/api/t/" queryKey={["t", 1]} />)
    expect(await screen.findByText("Incomplete")).toBeTruthy()
    expect(screen.getByText("Trace")).toBeTruthy()
    expect(screen.queryByText("Trace map")).toBeNull()
    expect(screen.getByRole("button", { name: "Left to right" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Top to bottom" })).toBeTruthy()
    expect(await screen.findByTestId("canvas")).toBeTruthy()
  })

  it("draws the run as the Diagram does, with an Export menu", async () => {
    answers["/api/t/"] = {
      ...linear(true),
      device_graph: {
        nodes: [node("dev:1", "sw-01", "sw-01"), node("dev:2", "b", "b")],
        edges: [],
      },
    }
    mount(
      <TraceSection
        url="/api/t/"
        queryKey={["t", 4]}
        focusNodeId="dev:1"
        name="Trace · C-001"
      />
    )
    await screen.findByTestId("canvas")
    expect(canvasProps.at(-1)).toMatchObject({
      nodeStyle: "diagram",
      diagramMode: "detailed",
      diagramLine: "elbow",
      direction: "LR",
      focusNodeId: "dev:1",
    })
    expect(screen.getByRole("button", { name: /Export/ })).toBeTruthy()
    // The legend waits on its chip.
    expect(screen.getByRole("button", { name: "Legend" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Top to bottom" }))
    expect(canvasProps.at(-1)).toMatchObject({ direction: "TB" })
  })

  it("says Not cabled. as an empty state", async () => {
    answers["/api/t/"] = UNCABLED
    mount(<TraceSection url="/api/t/" queryKey={["t", 2]} />)
    expect(await screen.findByText("Not cabled.")).toBeTruthy()
    expect(screen.queryByText(/nothing to trace/)).toBeNull()
    // No map, so no axis to choose.
    expect(screen.queryByRole("button", { name: "Left to right" })).toBeNull()
  })

  it("loads with the shared loader", async () => {
    mount(<TraceSection url="/api/never/" queryKey={["t", 3]} />)
    expect((await screen.findByRole("status")).textContent).toBe("Loading…")
  })
})

describe("trace dialogs", () => {
  it("flags an incomplete run in the title and opens the cable by link", async () => {
    answers["/api/cables/c1/trace/"] = linear(false)
    mount(
      <CableTraceDialog
        target={{ id: "c1", label: "C-001" }}
        onOpenChange={() => {}}
      />
    )
    const title = await screen.findByRole("heading", { name: /Trace · C-001/ })
    expect(title.textContent).toContain("Incomplete")
    expect(screen.queryByText(/dead-ends/)).toBeNull()
    const open = screen.getByRole("link", { name: "Open cable" })
    expect(open.getAttribute("href")).toBe("/cables/c1")
    expect(open.querySelector("svg.lucide-arrow-up-right")).not.toBeNull()
  })

  it("asks for the trace the way every view of it does", async () => {
    answers["/api/cables/c1/trace/"] = linear(true)
    mount(
      <CableTraceDialog
        target={{ id: "c1", label: "C-001" }}
        onOpenChange={() => {}}
      />
    )
    await screen.findByText("srv-01")
    expect(apiMock).toHaveBeenCalledWith(
      "/api/cables/c1/trace/?include=card,link_ips"
    )
    expect(traceUrl("interface", "i1")).toBe(
      "/api/interfaces/i1/trace/?include=card,link_ips"
    )
  })

  it("has no badge on a complete run", async () => {
    answers["/api/interfaces/i1/trace/"] = linear(true)
    mount(
      <InterfaceTraceDialog
        target={{ id: "i1", name: "ge-0/0/1" }}
        onOpenChange={() => {}}
      />
    )
    await screen.findByText("srv-01")
    expect(screen.queryByText("Incomplete")).toBeNull()
    expect(
      screen.getByRole("link", { name: "Open interface" }).getAttribute("href")
    ).toBe("/interfaces/i1")
  })
})

describe("PathStrip", () => {
  it("hints with tooltips, never title=", () => {
    mount(
      <PathStrip
        steps={[
          {
            t: "chip",
            chip: {
              deviceId: "d1",
              device: "sw-01",
              ports: [{ name: "ge-0/0/1", interfaceId: "i1" }],
            },
          },
          { t: "seg", seg: { cableId: "c1", label: "cat6", self: false } },
          {
            t: "chip",
            chip: {
              deviceId: "d2",
              device: "srv-01",
              ports: [{ name: "eth0", interfaceId: "i2" }],
            },
          },
        ]}
        onTraceCable={() => {}}
      />
    )
    return screen.findByText("ge-0/0/1").then(() => {
      expect(document.querySelector("[title]")).toBeNull()
      expect(screen.getByRole("button", { name: "Trace cable" })).toBeTruthy()
    })
  })
})

describe("DevicePathsList", () => {
  it("marks an incomplete run with the badge and names the trace button", async () => {
    answers["/api/devices/d1/paths/"] = { runs: [run(false)] }
    const trace = vi.fn()
    mount(<DevicePathsList deviceId="d1" onTraceCables={trace} />)
    expect(await screen.findByText("Incomplete")).toBeTruthy()
    expect(screen.queryByText("incomplete")).toBeNull()
    const btn = screen.getByRole("button", { name: "Trace run" })
    expect(btn.getAttribute("title")).toBeNull()
    fireEvent.click(btn)
    expect(trace).toHaveBeenCalledWith(["c1"])
  })

  it("says Not cabled. when there is no run", async () => {
    answers["/api/devices/d1/paths/"] = { runs: [] }
    mount(<DevicePathsList deviceId="d1" />)
    expect(await screen.findByText("Not cabled.")).toBeTruthy()
  })
})

describe("DeviceMiniTopology", () => {
  it("counts runs and LLDP links and opens the device in Topology", async () => {
    answers["/api/devices/d1/paths/"] = { runs: [run(true), run(true)] }
    answers["/api/monitoring/topology/ghosts/"] = {
      nodes: [],
      edges: [{ id: "g1" }, { id: "g2" }, { id: "g3" }],
    }
    mount(<DeviceMiniTopology deviceId="d1" />)
    expect(await screen.findByText("runs")).toBeTruthy()
    expect(screen.getByText("LLDP links")).toBeTruthy()
    const open = screen.getByRole("link", { name: "Open in Topology" })
    expect(open.getAttribute("href")).toBe("/topology?device=d1")
    expect(open.querySelector("svg.lucide-share-2")).not.toBeNull()
    expect(screen.queryByText("Full map")).toBeNull()
  })

  it("draws its map as the Diagram does, this device outlined", async () => {
    answers["/api/devices/d1/paths/"] = { runs: [run(true)] }
    answers["/api/monitoring/topology/ghosts/"] = { nodes: [], edges: [] }
    answers["/api/devices/d1/map/"] = {
      nodes: [node("dev:d1", "sw-01", "sw-01"), node("dev:d2", "b", "b")],
      edges: [],
    }
    mount(<DeviceMiniTopology deviceId="d1" />, "/here?sub=map")
    await screen.findByTestId("canvas")
    expect(apiMock).toHaveBeenCalledWith(
      "/api/devices/d1/map/?include=card,link_ips"
    )
    expect(canvasProps.at(-1)).toMatchObject({
      nodeStyle: "diagram",
      diagramMode: "detailed",
      diagramLine: "elbow",
      focusNodeId: "dev:d1",
    })
    expect(canvasProps.at(-1)).not.toHaveProperty("originId")
    expect(screen.getByRole("button", { name: "Legend" })).toBeTruthy()
  })

  it("says one run in the singular", async () => {
    answers["/api/devices/d1/paths/"] = { runs: [run(true)] }
    answers["/api/monitoring/topology/ghosts/"] = { nodes: [], edges: [] }
    mount(<DeviceMiniTopology deviceId="d1" />)
    const n = await screen.findByText("1")
    expect(n.parentElement?.textContent).toBe("1 run")
  })
})

describe("TunnelMap", () => {
  it("has an empty state with no how-to", () => {
    mount(<TunnelMap tunnel={{ terminations: [] } as unknown as Tunnel} />)
    return screen.findByText("No terminations yet.").then((t) => {
      expect(t.nextElementSibling).toBeNull()
    })
  })
})

describe("VmTopologyCard", () => {
  it("is headed Topology and says what to turn on", async () => {
    answers["/api/vm-interfaces/"] = { count: 0, results: [] }
    answers["/api/virt-networks/"] = { count: 0, results: [] }
    answers["/api/virtualization-sources/s1/"] = {
      sync_networks: false,
      name: "vc",
    }
    mount(<VmTopologyCard vmId="v1" vmName="web-01" syncedFromId="s1" />)
    expect(await screen.findByText("Topology")).toBeTruthy()
    expect(await screen.findByText("No virtual networks yet.")).toBeTruthy()
    expect(
      await screen.findByText("Sync virtual switches & networks")
    ).toBeTruthy()
    expect(screen.queryByText("Network topology")).toBeNull()
    expect(document.body.textContent).not.toContain("v0.13.0")
  })

  it("keeps its heading while it loads", async () => {
    mount(<VmTopologyCard vmId="v1" />)
    expect(await screen.findByText("Topology")).toBeTruthy()
    expect(screen.getByRole("status").textContent).toBe("Loading…")
  })
})
