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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VmTopologyCard } from "./vm-topology-card"

// A VM's Topology card is the Virtual topology's rail diagram at VM scale:
// its networks as rails, its own card under the first with a leg to each.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

afterEach(cleanup)

let answers: Record<string, unknown> = {}
beforeEach(() => {
  answers = {}
  apiMock.mockReset()
  apiMock.mockImplementation((path: string) => {
    const key = Object.keys(answers).find((k) => path.startsWith(k))
    return key ? Promise.resolve(answers[key]) : new Promise(() => undefined)
  })
})

function mount(ui: React.ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{ui}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

const active = {
  id: "st1",
  name: "Running",
  slug: "running",
  color: "#22c55e",
  text_color: "#000000",
}

describe("VmTopologyCard", () => {
  it("draws the VM's networks as rails with its card on them", async () => {
    answers["/api/vm-interfaces/"] = {
      count: 1,
      results: [
        {
          id: "i9",
          name: "eth9",
          vlan: {
            id: "v30",
            vlan_id: 30,
            name: "backup",
            color: "",
            zone: { id: "z", name: "z", color: "#be185d", text_color: "#fff" },
          },
        },
      ],
    }
    answers["/api/virt-networks/"] = {
      count: 1,
      results: [
        {
          id: "n10",
          name: "prod",
          ext_key: "vmbr0:10",
          vswitch: "sw1",
          vswitch_name: "vmbr0",
          vlan: {
            id: "v10",
            vlan_id: 10,
            name: "prod",
            color: "#2563eb",
            status: { ...active, id: "st2", name: "Planned", color: "#f59e0b" },
          },
          vms: [
            {
              id: "vm1",
              name: "web-01",
              status: "Running",
              status_mini: active,
              role: { id: "r1", name: "Web", color: "#f97316" },
              iface: "net0",
            },
          ],
        },
      ],
    }
    mount(<VmTopologyCard vmId="vm1" vmName="web-01" />)
    expect(await screen.findByText("Topology")).toBeTruthy()
    // The synced network, with its switch at the rail's end and the VLAN's
    // status as its pill; the modelled interface's VLAN in its zone's color.
    const prod = await screen.findByRole("link", {
      name: "prod · VLAN 10, Planned, vmbr0",
    })
    expect(prod.getAttribute("href")).toBe("/vlans/v10")
    expect(prod.style.backgroundColor).toBe("rgb(37, 99, 235)")
    const backup = screen.getByRole("link", { name: "backup · VLAN 30" })
    expect(backup.style.backgroundColor).toBe("rgb(190, 24, 93)")
    // The VM's own card: its role's color and its status, dashed, and no
    // link - this is its page.
    const card = screen.getByText("web-01").closest("div[aria-label]")!
    expect(card.getAttribute("aria-label")).toBe("web-01, Running")
    expect(card.tagName).toBe("DIV")
    expect((card as HTMLElement).style.backgroundColor).toBe(
      "rgb(249, 115, 22)"
    )
    expect(card.querySelector("span[aria-hidden]")!.className).toContain(
      "border-dashed"
    )
    // A leg per interface, each named.
    expect(screen.getByText("net0")).toBeTruthy()
    expect(screen.getByText("eth9")).toBeTruthy()
    expect(document.querySelectorAll("svg line")).toHaveLength(2)
  })
})
