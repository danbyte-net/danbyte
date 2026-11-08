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
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SoftwareSummaryCard } from "@/components/software-summary-card"
import { OverviewTable } from "@/components/overview-table"

// The Overview's Software card on device and VM pages (#436), and the shared
// overview table it, the VM disks and the support contracts render in.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  perms: { view: true },
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => perms.view,
    humanIds: false,
  }),
  objCan: () => true,
}))

afterEach(() => {
  cleanup()
  apiMock.mockReset()
  perms.view = true
})

function install(i: number) {
  return {
    id: `i${i}`,
    application: { id: `a${i}`, name: `App ${i}`, slug: `app-${i}`, path: "" },
    device: null,
    virtual_machine: { id: "vm1", name: "vm1" },
    version: `1.${i}`,
    effective_release: null,
    effective_end: null,
    effective_source: null,
  }
}

function serve(loaded: number, total: number) {
  apiMock.mockImplementation((path: string) =>
    path.startsWith("/api/installed-software/")
      ? Promise.resolve({
          count: total,
          results: Array.from({ length: loaded }, (_, i) => install(i)),
        })
      : path.startsWith("/api/eol/settings/")
        ? Promise.resolve({ enabled: false, warning_days: 180 })
        : new Promise(() => undefined)
  )
}

function mount(node: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
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

const softwareCalls = () =>
  apiMock.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith("/api/installed-software/"))

describe("SoftwareSummaryCard", () => {
  it("asks for one card's worth of the VM's installs", async () => {
    serve(2, 2)
    mount(<SoftwareSummaryCard parent={{ kind: "vm", id: "vm1" }} />)
    expect(await screen.findByText("App 0")).toBeTruthy()
    expect(softwareCalls()).toEqual([
      "/api/installed-software/?virtual_machine=vm1&page_size=8",
    ])
    expect(screen.getByText("1.1")).toBeTruthy()
    expect(screen.getByText("App 1").closest("a")!.getAttribute("href")).toBe(
      "/applications/a1"
    )
    expect(screen.queryByText(/View all/)).toBeNull()
  })

  it("links to the tab when there are more than it shows", async () => {
    serve(8, 12)
    mount(<SoftwareSummaryCard parent={{ kind: "device", id: "d1" }} />)
    const link = await screen.findByText("View all 12")
    expect(link.closest("a")!.getAttribute("href")).toBe(
      "/devices/d1?tab=software"
    )
    expect(softwareCalls()[0]).toContain("device=d1")
  })

  it("is one muted line when nothing is installed", async () => {
    serve(0, 0)
    mount(<SoftwareSummaryCard parent={{ kind: "vm", id: "vm1" }} />)
    expect(await screen.findByText("No software recorded.")).toBeTruthy()
    expect(document.querySelector("table")).toBeNull()
  })

  it("renders nothing without the view permission", async () => {
    perms.view = false
    serve(1, 1)
    mount(<SoftwareSummaryCard parent={{ kind: "vm", id: "vm1" }} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByText("Software")).toBeNull()
    expect(softwareCalls()).toEqual([])
  })
})

describe("OverviewTable", () => {
  it("has no footer chrome and gives the spare width to the last column", () => {
    render(
      <OverviewTable
        title="Disks"
        columns={[
          { id: "a", header: "Disk", cell: (r: { k: string }) => r.k },
          { id: "b", header: "Controller", cell: () => "SCSI" },
        ]}
        data={[{ k: "disk-0" }]}
        getRowKey={(r) => r.k}
      />
    )
    expect(screen.getByText("Disks")).toBeTruthy()
    expect(screen.queryByText(/rows?\b/i)).toBeNull()
    const heads = document.querySelectorAll("th")
    expect(heads[0].className).not.toContain("w-full")
    expect(heads[1].className).toContain("w-full")
  })
})
