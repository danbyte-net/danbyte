// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { RouteComponent } from "@tanstack/react-router"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { Route as Devices } from "./devices.index"
import { Route as Interfaces } from "./interfaces.index"
import { Route as Cables } from "./cables.index"
import { Route as Vms } from "./virtual-machines.index"
import { mountRoute, stubDom } from "./-bulk-list-test-utils"

// The Devices, Interfaces, Cables and Virtual machines lists page on the
// server (#482): one request per page in the slim row, the sort and the rail
// sent as params, the rail's counts from <list>/facets/, "Select all N" from
// <list>/table-ids/ and a Download that walks every matching row.

const { apiMock, exported } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  exported: { rows: null as unknown[] | null },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    children,
    count,
  }: {
    rail?: ReactNode
    children: ReactNode
    count?: number
  }) => (
    <div>
      <span data-testid="count">{count}</span>
      <aside data-testid="rail">{rail}</aside>
      {children}
    </div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))
vi.mock("@/lib/table-export", async (orig) => ({
  ...(await orig<object>()),
  exportTable: (_t: unknown, _f: unknown, _o: unknown, rows?: unknown[]) => {
    exported.rows = rows ?? null
  },
}))

const TOTAL = 60
const status = {
  id: "st-a",
  name: "Active",
  color: "#10b981",
  text_color: "#fff",
}

interface ListCase {
  name: string
  path: string
  endpoint: string
  component: unknown
  row: (i: number) => Record<string, unknown>
  /** A rail option: its facet id, value and label. */
  facet: { id: string; value: string; label: string }
  /** A header that sorts on the server, and its column id. */
  sort: { header: string; id: string }
  /** Text of the first row. */
  first: string
}

const device = (i: number) => ({
  id: `id-${i}`,
  numid: i,
  name: `dev-${i}`,
  status,
  role: null,
  platform: null,
  device_type: null,
  site: { id: "s1", name: "Alpha" },
  rack: null,
  cabinet: null,
  tags: [],
  ip_count: 0,
  coverage: null,
  lifecycle_next: null,
  device_profiles: [],
  custom_fields: {},
  description: "",
  updated_at: "2026-11-01T00:00:00Z",
})

const CASES: ListCase[] = [
  {
    name: "devices",
    path: "/devices",
    endpoint: "/api/devices/",
    component: (
      Devices as unknown as { options: { component: RouteComponent } }
    ).options.component,
    row: device,
    facet: { id: "status", value: "st-p", label: "Planned" },
    sort: { header: "Name", id: "name" },
    first: "dev-1",
  },
  {
    name: "interfaces",
    path: "/interfaces",
    endpoint: "/api/interfaces/",
    component: (
      Interfaces as unknown as { options: { component: RouteComponent } }
    ).options.component,
    row: (i) => ({
      id: `id-${i}`,
      name: `eth${i}`,
      device: { id: "d1", name: "sw-1" },
      enabled: true,
      status: null,
      speed: "",
      mtu: null,
      mode: "",
      vlan: null,
      tagged_vlans: [],
      cable: null,
      cable_count: 0,
      reservation: null,
      mark_connected: false,
      virtual: false,
      tunnel_terminations: [],
      tags: [],
      custom_fields: {},
      description: "",
    }),
    facet: { id: "status", value: "none", label: "Active" },
    sort: { header: "Interface", id: "name" },
    first: "eth1",
  },
  {
    name: "cables",
    path: "/cables",
    endpoint: "/api/cables/",
    component: (Cables as unknown as { options: { component: RouteComponent } })
      .options.component,
    row: (i) => ({
      id: `id-${i}`,
      numid: i,
      label: `C${i}`,
      type: "cat6",
      type_display: "CAT6",
      status,
      a_terminations: [],
      b_terminations: [],
      tags: [],
      custom_fields: {},
      description: "",
      updated_at: "2026-11-01T00:00:00Z",
    }),
    facet: { id: "type", value: "cat6", label: "CAT6" },
    sort: { header: "Status", id: "status" },
    first: "C1",
  },
  {
    name: "virtual machines",
    path: "/virtual-machines",
    endpoint: "/api/virtual-machines/",
    component: (Vms as unknown as { options: { component: RouteComponent } })
      .options.component,
    row: (i) => ({
      id: `id-${i}`,
      numid: i,
      name: `vm-${i}`,
      cluster: { id: "c1", name: "C1" },
      group: null,
      status,
      power_state: null,
      synced_from: null,
      vcpus: 2,
      memory_mb: 1024,
      disk_gb: 10,
      primary_ip: null,
      site: null,
      role: null,
      platform: null,
      lifecycle_next: null,
      software_version: "",
      device_profiles: [],
      tags: [],
      custom_fields: {},
      updated_at: "2026-11-01T00:00:00Z",
    }),
    facet: { id: "cluster", value: "C1", label: "C1" },
    sort: { header: "Name", id: "name" },
    first: "vm-1",
  },
]

function answer(c: ListCase, path: string): unknown {
  const url = new URL(path, "http://x")
  const p = url.pathname
  if (p === "/api/me/prefs/")
    return { values: { page_size: 25 }, defaults: {}, user_set: [] }
  if (p === `${c.endpoint}facets/`)
    return {
      facets: {
        [c.facet.id]: [
          { value: c.facet.value, label: c.facet.label, count: 10 },
          { value: "other", label: "Other", count: 50 },
        ],
      },
      sortable: [c.sort.id, "updated"],
    }
  if (p === `${c.endpoint}table-ids/`)
    return {
      count: TOTAL,
      truncated: false,
      results: Array.from({ length: TOTAL }, (_, i) => `id-${i + 1}`),
    }
  if (p === c.endpoint) {
    const page = Number(url.searchParams.get("page") ?? 1)
    const size = Number(url.searchParams.get("page_size") ?? 100)
    const start = (page - 1) * size
    const rows = Array.from(
      { length: Math.max(0, Math.min(size, TOTAL - start)) },
      (_, i) => c.row(start + i + 1)
    )
    return {
      count: TOTAL,
      next: start + size < TOTAL ? "next" : null,
      previous: null,
      results: rows,
    }
  }
  return { results: [], count: 0, statuses: {} }
}

const pageCalls = (c: ListCase) =>
  apiMock.mock.calls
    .map(([p]) => p)
    .filter((p) => new URL(p, "http://x").pathname === c.endpoint)
    .map((p) => new URL(p, "http://x").searchParams)

/** Let the page's own follow-up requests (monitoring, SLA) land: the
 * columns rebuild with them, and a header found before that is replaced. */
const settle = () => new Promise((r) => setTimeout(r, 400))

beforeAll(stubDom)
afterEach(() => cleanup())

describe.each(CASES)(
  "the $name list pages on the server",
  { timeout: 20_000 },
  (c) => {
    beforeEach(() => {
      apiMock.mockReset()
      exported.rows = null
      apiMock.mockImplementation(async (path) => answer(c, path))
    })

    it("asks for one slim page, not the whole list", async () => {
      mountRoute(c.path, c.component)
      expect(
        await screen.findByText(c.first, undefined, { timeout: 8000 })
      ).toBeTruthy()
      const calls = pageCalls(c)
      expect(calls.length).toBeGreaterThan(0)
      for (const params of calls) {
        expect(params.get("view")).toBe("table")
        expect(params.get("page")).toBe("1")
        expect(Number(params.get("page_size"))).toBeLessThanOrEqual(25)
      }
      // The count is the server's, not the page's.
      expect(screen.getByTestId("count").textContent).toBe(String(TOTAL))
      expect(screen.getByText("Page 1 of 3")).toBeTruthy()
      // The next page is a request of its own.
      fireEvent.click(screen.getByRole("button", { name: "Next" }))
      await waitFor(() =>
        expect(pageCalls(c).some((p) => p.get("page") === "2")).toBe(true)
      )
    })

    it("sorts on the server", async () => {
      mountRoute(c.path, c.component)
      await screen.findByText(c.first, undefined, { timeout: 8000 })
      await settle()
      fireEvent.click(
        await screen.findByRole("button", { name: c.sort.header })
      )
      await waitFor(() =>
        expect(pageCalls(c).at(-1)?.get("ordering")).toBe(c.sort.id)
      )
      fireEvent.click(screen.getByRole("button", { name: c.sort.header }))
      await waitFor(() =>
        expect(pageCalls(c).at(-1)?.get("ordering")).toBe(`-${c.sort.id}`)
      )
    })

    it("filters from the rail on the server, with the server's counts", async () => {
      mountRoute(c.path, c.component)
      await screen.findByText(c.first, undefined, { timeout: 8000 })
      const rail = screen.getByTestId("rail")
      const option = await within(rail).findByRole("checkbox", {
        name: c.facet.label,
      })
      expect(within(rail).getByText("50")).toBeTruthy()
      fireEvent.click(option)
      await waitFor(() =>
        expect(pageCalls(c).at(-1)?.get(`f_${c.facet.id}`)).toBe(c.facet.value)
      )
      // The rail's counts follow the filters too.
      const facetCalls = apiMock.mock.calls
        .map(([p]) => new URL(p, "http://x"))
        .filter((u) => u.pathname === `${c.endpoint}facets/`)
      expect(
        facetCalls.some(
          (u) => u.searchParams.get(`f_${c.facet.id}`) === c.facet.value
        )
      ).toBe(true)
    })

    it("selects across pages from the server's ids", async () => {
      mountRoute(c.path, c.component)
      await screen.findByText(c.first, undefined, { timeout: 8000 })
      await settle()
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
      fireEvent.click(
        await screen.findByRole("button", { name: `Select all ${TOTAL}` })
      )
      // The table's count, and the bulk bar's where the list has one.
      expect(
        (await screen.findAllByText(`${TOTAL} selected`)).length
      ).toBeGreaterThan(0)
      expect(
        apiMock.mock.calls.some(
          ([p]) => new URL(p, "http://x").pathname === `${c.endpoint}table-ids/`
        )
      ).toBe(true)
    })

    it("downloads every matching row, not the page", async () => {
      mountRoute(c.path, c.component)
      await screen.findByText(c.first, undefined, { timeout: 8000 })
      fireEvent.pointerDown(screen.getByRole("button", { name: /Download/ }), {
        button: 0,
        ctrlKey: false,
      })
      fireEvent.click(await screen.findByText("CSV (spreadsheet)"))
      await waitFor(() => expect(exported.rows?.length).toBe(TOTAL))
      expect(pageCalls(c).some((p) => p.get("page_size") === "1000")).toBe(true)
    })
  }
)
