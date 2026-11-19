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

import type { MacEntry } from "@/lib/api"
import { Route } from "./macs.index"
import { mountRoute, stubDom } from "./-bulk-list-test-utils"

// The Recorded MAC list pages on the server (#527): one request per page,
// the search, sort and rail sent as params, the rail's counts from
// /api/macs/facets/ and "Select all" from /api/macs/table-ids/ - whose ids
// are the MACs the bulk removal takes. A search that matches nothing still
// leaves no selection behind (#251).

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
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
// The page opens on its Recorded tab - the list under test.
vi.mock("@/lib/use-url-tab", () => ({
  useUrlTab: () => ["recorded", () => {}],
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    search,
    summary,
    children,
    count,
  }: {
    rail?: ReactNode
    search: { value: string; onChange: (v: string) => void }
    summary?: ReactNode
    children: ReactNode
    count?: number
  }) => (
    <div>
      <span data-testid="count">{count}</span>
      <input
        aria-label="Search"
        value={search.value}
        onChange={(e) => search.onChange(e.target.value)}
      />
      <div data-testid="summary">{summary}</div>
      <aside data-testid="rail">{rail}</aside>
      {children}
    </div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))
vi.mock("@/components/mac-object-dialog", () => ({
  MacObjectDialog: () => null,
}))
vi.mock("@/components/oui-ranges-dialog", () => ({
  OuiRangesDialog: () => null,
}))

const TOTAL = 60
const mac = (i: number) => `aa:00:00:00:00:${String(i).padStart(2, "0")}`
const entry = (i: number): MacEntry & { id: string } => ({
  id: mac(i),
  mac: mac(i).toUpperCase(),
  vendor: null,
  interfaces: [],
  vm_interfaces: [],
  ips: [],
  objects: [],
  location: null,
})

let total = TOTAL
let building = false
let first: (i: number) => MacEntry & { id: string } = entry

function answer(path: string): unknown {
  const url = new URL(path, "http://x")
  const p = url.pathname
  if (p === "/api/me/prefs/")
    return { values: { page_size: 25 }, defaults: {}, user_set: [] }
  if (p === "/api/macs/facets/")
    return {
      facets: {
        vendor: [{ value: "Acme", label: null, count: 4 }],
        location: [{ value: "__none__", label: "Not learned", count: TOTAL }],
      },
      sortable: ["mac", "location"],
    }
  if (p === "/api/macs/table-ids/")
    return {
      count: total,
      truncated: false,
      results: Array.from({ length: total }, (_, i) => mac(i + 1)),
    }
  if (p === "/api/macs/") {
    const page = Number(url.searchParams.get("page") ?? 1)
    const size = Number(url.searchParams.get("page_size") ?? 100)
    const start = (page - 1) * size
    const n = url.searchParams.get("search") === "nothing" ? 0 : total
    return {
      count: n,
      next: start + size < n ? "next" : null,
      previous: null,
      results: Array.from(
        { length: Math.max(0, Math.min(size, n - start)) },
        (_, i) => first(start + i + 1)
      ),
      summary: { building, updating: false },
    }
  }
  return { results: [], count: 0 }
}

const pageCalls = () =>
  apiMock.mock.calls.map(([p]) => p).filter((p) => p.startsWith("/api/macs/?"))

const component = (
  Route as unknown as { options: { component: RouteComponent } }
).options.component

afterEach(cleanup)
beforeAll(async () => {
  stubDom()
  const lazy = component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})
beforeEach(() => {
  total = TOTAL
  building = false
  first = entry
  apiMock.mockReset()
  apiMock.mockImplementation((path) => Promise.resolve(answer(path)))
})

const rowOf = (text: string) => screen.getByText(text).closest("tr")!

describe("MAC list (#527)", () => {
  it("asks the server for one page and shows its count", async () => {
    mountRoute("/macs", component)
    await screen.findByText(mac(1).toUpperCase())
    expect(screen.getByTestId("count").textContent).toBe(String(TOTAL))
    const call = pageCalls().at(-1)!
    expect(call).toContain("page=1")
    expect(call).toContain("page_size=25")
    expect(screen.queryByText(mac(26).toUpperCase())).toBeNull()
  })

  it("searches on the server and drops the selection when nothing matches", async () => {
    mountRoute("/macs", component)
    await screen.findByText(mac(1).toUpperCase())
    fireEvent.click(
      within(rowOf(mac(1).toUpperCase())).getByRole("checkbox", {
        name: "Select row",
      })
    )
    expect(await screen.findByRole("button", { name: /Remove/ })).toBeTruthy()
    fireEvent.change(screen.getByLabelText("Search"), {
      target: { value: "nothing" },
    })
    await waitFor(() =>
      expect(pageCalls().some((p) => p.includes("search=nothing"))).toBe(true)
    )
    expect(await screen.findByText("No results.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Remove/ })).toBeNull()
  })

  it("filters by ?tag=<slug> on the server", async () => {
    mountRoute("/macs", component, "/macs?tag=core")
    await screen.findByText(mac(1).toUpperCase())
    expect(pageCalls().at(-1)).toContain("f_tags=core")
  })

  it("shows where each MAC was learned", async () => {
    first = (i) =>
      i === 1
        ? {
            ...entry(1),
            location: {
              kind: "access",
              site: { id: "s1", name: "HQ" },
              location: { id: "l1", name: "Room 1" },
              device: { id: "d1", name: "sw-acc-03" },
              interface: { id: "i1", name: "Gi1/0/5" },
              port_name: "Gi1/0/5",
              vlan: 10,
              since: "2026-10-01T10:00:00Z",
              last_seen: "2026-10-01T12:00:00Z",
              stale: false,
            },
          }
        : entry(i)
    mountRoute("/macs", component)
    await screen.findByText(mac(1).toUpperCase())
    const row = within(rowOf(mac(1).toUpperCase()))
    expect(row.getByText("sw-acc-03")).toBeTruthy()
    expect(row.getByText("HQ · Room 1")).toBeTruthy()
  })

  it("says the list is still building after an upgrade", async () => {
    building = true
    mountRoute("/macs", component)
    await screen.findByText(mac(1).toUpperCase())
    expect(
      within(screen.getByTestId("summary")).getByText("Building")
    ).toBeTruthy()
  })

  it("says the list is empty only when there are no MACs at all", async () => {
    total = 0
    mountRoute("/macs", component)
    expect(await screen.findByText(/No MAC addresses yet/)).toBeTruthy()
  })
})
