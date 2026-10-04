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
    // Nothing to export yet.
    expect(
      screen.getByRole("button", { name: /Export/ }).hasAttribute("disabled")
    ).toBe(true)
  })

  it("shows one loader while it fetches", async () => {
    mount()
    await screen.findByRole("heading", { name: "Virtual topology" })
    expect(screen.getAllByRole("status")).toHaveLength(1)
    expect(screen.getByRole("status").textContent).toBe("Loading…")
  })

  it("groups networks under their switch, VMs once, colored from data", async () => {
    const active = {
      id: "st1",
      name: "Active",
      slug: "active",
      color: "#22c55e",
      text_color: "#000000",
    }
    answers["/api/virtual-switches/"] = {
      count: 1,
      results: [
        {
          id: "sw1",
          name: "vmbr0",
          kind: "bridge",
          kind_display: "Linux bridge",
          uplink_interfaces: [
            { id: "if1", name: "eno1", device: { id: "h1", name: "pve-01" } },
          ],
        },
      ],
    }
    const vm = {
      id: "vm1",
      name: "web-01",
      status: "Active",
      status_mini: active,
      role: { id: "r1", name: "Web", color: "#f97316" },
    }
    answers["/api/virt-networks/"] = {
      count: 2,
      results: [
        {
          id: "n20",
          name: "dmz",
          ext_key: "vmbr0:20",
          vswitch: "sw1",
          vlan: {
            id: "v20",
            vlan_id: 20,
            name: "dmz",
            color: "#2563eb",
            status: { ...active, id: "st2", name: "Planned", color: "#f59e0b" },
          },
          vms: [{ ...vm, iface: "net1" }],
        },
        {
          id: "n10",
          name: "prod",
          ext_key: "vmbr0:10",
          vswitch: "sw1",
          vlan: { id: "v10", vlan_id: 10, name: "prod", color: "" },
          vms: [{ ...vm, iface: "net0" }],
        },
      ],
    }
    mount()
    // The switch heads its section and links to it; its host NIC too.
    const sw = await screen.findByRole("link", { name: "vmbr0" })
    expect(sw.getAttribute("href")).toBe("/virtual-switches/sw1")
    expect(screen.getByText("Linux bridge")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "eno1, pve-01" }).getAttribute("href")
    ).toBe("/interfaces/if1")
    // Networks as rails by VLAN, the VLAN's status as its pill.
    const rails = screen
      .getAllByRole("link")
      .filter((a) => a.getAttribute("href")?.startsWith("/vlans/"))
    expect(rails.map((a) => a.getAttribute("aria-label"))).toEqual([
      "prod · VLAN 10",
      "dmz · VLAN 20, Planned",
    ])
    // The VM once, in its role's color, wearing its status, dashed.
    const cards = screen.getAllByRole("link", { name: "web-01, Active" })
    expect(cards).toHaveLength(1)
    expect(cards[0].getAttribute("href")).toBe("/virtual-machines/vm1")
    expect(cards[0].style.backgroundColor).toBe("rgb(249, 115, 22)")
    expect(cards[0].querySelector("span[aria-hidden]")!.className).toContain(
      "border-dashed"
    )
    expect(screen.getByText("External network")).toBeTruthy()
    // The legend and the second bar.
    expect(screen.getByText("Legend")).toBeTruthy()
    expect(screen.getByText("Host NIC")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy()
    const exp = screen.getByRole("button", { name: /Export/ })
    expect(exp.hasAttribute("disabled")).toBe(false)
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
