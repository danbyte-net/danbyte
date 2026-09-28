// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
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

import { Route } from "./virtual-topology.index"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

afterEach(cleanup)

// The route's component is code-split: load it once up front, so no test
// spends its wait on the import.
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})

/** What the stubbed API answers, by path prefix; a missing entry never
 * resolves, so the page stays loading. */
let answers: Record<string, unknown> = {}
beforeEach(() => {
  answers = {
    "/api/virtualization-sources/": {
      count: 1,
      results: [{ id: "s1", name: "vcenter" }],
    },
    "/api/virtual-switches/": { count: 0, results: [] },
  }
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

function mount() {
  const Page = Route.options.component!
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/virtual-topology",
    component: Page,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/virtual-topology"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

describe("Virtual topology page", () => {
  it("is titled Virtual topology, filters by Any source and explains itself in an info tip", async () => {
    answers["/api/virt-networks/"] = { count: 0, results: [] }
    mount()
    expect(
      await screen.findByRole("heading", { name: "Virtual topology" })
    ).toBeTruthy()
    expect(screen.getByRole("combobox").textContent).toContain("Any source")
    expect(
      screen.getByRole("button", { name: "More information" })
    ).toBeTruthy()
    expect(document.body.textContent).not.toContain("Networks are rails")
  })

  it("says what to turn on when there is nothing to draw", async () => {
    answers["/api/virt-networks/"] = { count: 0, results: [] }
    mount()
    expect(await screen.findByText("No virtual networks yet.")).toBeTruthy()
    expect(screen.getByText("Sync virtual switches & networks")).toBeTruthy()
  })

  it("shows one loader while it fetches", async () => {
    mount()
    await screen.findByRole("heading", { name: "Virtual topology" })
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.getByRole("status").textContent).toBe("Loading…")
  })

  it("labels a network rail with one spaced dot", async () => {
    answers["/api/virt-networks/"] = {
      count: 1,
      results: [
        {
          id: "n1",
          name: "prod",
          ext_key: "net-1",
          vswitch: null,
          vlan: { id: "v10", vlan_id: 10, name: "prod", color: "" },
          vms: [
            { id: "vm1", name: "web-01", status: "Running", iface: "nic0" },
          ],
        },
      ],
    }
    mount()
    expect(await screen.findByText("prod · VLAN 10")).toBeTruthy()
    expect(screen.getByText("web-01")).toBeTruthy()
  })
})
