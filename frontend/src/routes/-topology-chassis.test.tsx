// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { chassisSpecs } from "@/components/topology/diagram/chassis"
import type { ChassisOptions } from "@/components/topology/diagram/chassis"
import type {
  TopoNode,
  TopologyGraph,
  TopologyQuery,
  TopologyViewSaved,
} from "@/lib/api"
import { Route as LayoutRoute } from "./topology"
import { Route } from "./topology.index"

// The Diagram's virtual chassis as the page drives them: how a saved view
// stacks when it says nothing itself, and what removing a stack member or
// adding connected devices does to a hand-picked map's set while a chassis
// is placed on it.

const { apiMock, fetchMock, canvasProps, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  fetchMock: vi.fn<(q: TopologyQuery, init?: unknown) => Promise<unknown>>(),
  canvasProps: [] as Record<string, unknown>[],
  toastMock: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
    dismiss: vi.fn(),
  }),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
  fetchTopology: fetchMock,
}))
vi.mock("sonner", async (orig) => ({
  ...(await orig<object>()),
  toast: toastMock,
}))
// React Flow has no layout to measure in jsdom: what matters here is what
// the canvas is asked to draw.
vi.mock("@/components/topology/topology-canvas", async () => ({
  ...(await vi.importActual<object>("@/components/topology/edge-style")),
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
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
// The router restores the scroll on a navigation; jsdom has no scrolling.
window.scrollTo = () => undefined

const V = "5b0e8c1a-0000-4000-8000-0000000000a1"
const VC = "7c1d5e92-3b6f-4a0d-8e47-1b9c2d5f6e05"
const CORE = "c0000000-0000-4000-8000-000000000001"
const SW1 = "c0000000-0000-4000-8000-000000000002"
const SW2 = "c0000000-0000-4000-8000-000000000003"
const ASW = "c0000000-0000-4000-8000-000000000004"
const MAP_KEY = "danbyte-topology-map"

const dev = (
  id: string,
  name: string,
  vc?: { position: number; master: boolean }
): TopoNode => ({
  id: `dev:${id}`,
  type: "device",
  data: {
    name,
    device_id: id,
    role: { id: "r1", name: "Access", color: "#2563eb" },
    ...(vc ? { vc: { id: VC, name: "stack1", ...vc } } : {}),
  },
})
const core = dev(CORE, "core1")
const sw1 = dev(SW1, "sw1", { position: 1, master: true })
const sw2 = dev(SW2, "sw2", { position: 2, master: false })
const asw = dev(ASW, "asw1")

/** The map: core1 and the stack's two members. */
const MAP: TopologyGraph = { nodes: [core, sw1, sw2], edges: [] }
/** What is cabled to core1: the stack's members and asw1. */
const AROUND_CORE: TopologyGraph = {
  nodes: [core, sw1, sw2, asw],
  edges: [],
}

const savedView = (state: Record<string, unknown>): TopologyViewSaved => ({
  id: V,
  numid: 1,
  name: "Old",
  state,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
})

/** What the stubbed API answers, by exact path, else by path prefix; a
 * missing entry never resolves. */
let answers: Record<string, unknown> = {}
const answer = (path: string) => {
  const key =
    path in answers
      ? path
      : Object.keys(answers).find((k) => path.startsWith(k))
  return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
}

afterEach(cleanup)
// The route's component is code-split: load it once up front.
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  localStorage.clear()
  canvasProps.length = 0
  toastMock.mockReset()
  answers = {
    "/api/me/": {
      is_authenticated: true,
      is_superuser: true,
      perms: [],
      permissions: {},
    },
    "/api/topology-views/default/": { id: null },
    "/api/topology-views/?picker=1": {
      count: 1,
      next: null,
      previous: null,
      results: [
        { id: V, numid: 1, name: "Old", updated_at: "2026-09-01T00:00:00Z" },
      ],
    },
  }
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => answer(path))
  fetchMock.mockReset()
  fetchMock.mockImplementation((q: TopologyQuery) =>
    Promise.resolve(q.device ? AROUND_CORE : MAP)
  )
})

function mount(url: string) {
  const Page = Route.options.component!
  const root = createRootRoute({ component: () => <Outlet /> })
  const layout = LayoutRoute.update({
    id: "/topology",
    path: "/topology",
    getParentRoute: () => root,
  } as never)
  const page = Route.update({
    id: "/",
    path: "/",
    component: Page,
    getParentRoute: () => layout,
  } as never)
  const router = createRouter({
    routeTree: root.addChildren([layout.addChildren([page])]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

interface Drawn {
  graph?: TopologyGraph
  chassis?: ChassisOptions
  onSelectNode: (d: TopoNode["data"]) => void
  onNodeContext: (
    node: { id: string; type: string; data: unknown },
    x: number,
    y: number
  ) => void
}
const last = () => canvasProps.at(-1) as unknown as Drawn | undefined
const nodeOf = (id: string) =>
  last()!.graph!.nodes.find((n) => n.data.device_id === id)!
/** The canvas once it has the map. */
async function drawn() {
  await waitFor(() => expect(last()?.graph?.nodes.length).toBe(3), {
    timeout: 5000,
  })
  return last()!
}

describe("Diagram stacking a view does not name", () => {
  // This browser's No view stacks top to bottom.
  const noViewStacks = () =>
    localStorage.setItem(
      MAP_KEY,
      JSON.stringify({ filters: { diagram: { chassis: "v" } } })
    )

  it("keeps a view arranged before stacks unstacked, whatever No view does here", async () => {
    noViewStacks()
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: { viewStyle: "diagram", diagram: { face: "card" } },
      positions_by_style: {
        diagram: { [`dev:${SW1}`]: [0, 0], [`dev:${SW2}`]: [400, 300] },
      },
    })
    mount(`/topology?view=${V}`)
    const d = await drawn()
    await waitFor(() => expect(last()?.chassis?.mode).toBe("off"))
    expect(chassisSpecs(d.graph!.nodes, last()?.chassis)).toEqual([])
    expect(screen.queryByText("Edited")).toBeNull()
  })

  it("keeps a view arranged on Wiring unstacked too", async () => {
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: { viewStyle: "stencil" },
      positions_by_style: { stencil: { [`dev:${SW1}`]: [0, 0] } },
    })
    mount(`/topology?view=${V}`)
    await drawn()
    await waitFor(() => expect(last()?.chassis?.mode).toBe("off"))
  })

  it("stacks a view not arranged by hand, and one that says so", async () => {
    noViewStacks()
    localStorage.setItem(
      MAP_KEY,
      JSON.stringify({ filters: { diagram: { chassis: "off" } } })
    )
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: { viewStyle: "diagram" },
    })
    mount(`/topology?view=${V}`)
    await drawn()
    await waitFor(() => expect(last()?.chassis?.mode).toBe("v"))
    cleanup()
    canvasProps.length = 0
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: { viewStyle: "diagram", diagram: { chassis: "h" } },
      positions_by_style: { diagram: { [`dev:${SW1}`]: [0, 0] } },
    })
    mount(`/topology?view=${V}`)
    await drawn()
    await waitFor(() => expect(last()?.chassis?.mode).toBe("h"))
  })

  it("opens No view as this browser left it", async () => {
    localStorage.setItem(
      MAP_KEY,
      JSON.stringify({ filters: { diagram: { chassis: "h" } } })
    )
    mount("/topology?view=none&tab=diagram")
    await drawn()
    await waitFor(() => expect(last()?.chassis?.mode).toBe("h"))
  })
})

describe("A placed chassis keeps its members", () => {
  it("Delete on a member keeps it, and its look, on the map", async () => {
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: {
        viewStyle: "diagram",
        devices: [CORE],
        chassis: [VC],
        diagram: { chassis: "v" },
      },
      nodes: { [SW1]: { face: "photo" } },
    })
    mount(`/topology?view=${V}`)
    const d = await drawn()
    expect(nodeOf(SW1).data).toMatchObject({ face: "photo" })
    act(() => d.onSelectNode(nodeOf(SW1).data))
    fireEvent.keyDown(document.body, { key: "Delete" })
    expect(toastMock).toHaveBeenCalledWith("Part of stack1", {
      description: "Remove the chassis from the map, or hide the device.",
    })
    // Nothing changed: its photo stays, and the view is not edited.
    expect(nodeOf(SW1).data).toMatchObject({ face: "photo" })
    expect(screen.queryByText("Edited")).toBeNull()
  })

  it("a member also in the set leaves the set and keeps its look", async () => {
    answers[`/api/topology-views/${V}/`] = savedView({
      filters: {
        viewStyle: "diagram",
        devices: [CORE, SW1],
        chassis: [VC],
        diagram: { chassis: "v" },
      },
      nodes: { [SW1]: { face: "photo" } },
    })
    mount(`/topology?view=${V}`)
    const d = await drawn()
    act(() => d.onSelectNode(nodeOf(SW1).data))
    fireEvent.keyDown(document.body, { key: "Delete" })
    expect(await screen.findByText("Edited")).toBeTruthy()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ devices: [CORE], chassis: [VC] }),
        expect.anything()
      )
    )
    expect(nodeOf(SW1).data).toMatchObject({ face: "photo" })
  })

  it("Add connected devices leaves the members to their chassis", async () => {
    const router = mount(
      `/topology?view=none&tab=diagram&devices=${CORE}&chassis=${VC}`
    )
    const d = await drawn()
    const c = nodeOf(CORE)
    act(() => d.onNodeContext({ id: c.id, type: "card", data: c.data }, 5, 5))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Add connected devices/ })
    )
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({
        devices: `${CORE},${ASW}`,
        chassis: VC,
      })
    )
  })
})
