// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { DeviceDependenciesTab } from "./device-dependencies-tab"

// A device's Dependencies tab (#450): the trees up and down with media,
// groups and hidden devices, the peers, and "What if this fails?" with a
// way into planning it.

const { apiMock, navMock, can } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  navMock: vi.fn(),
  can: { current: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: () => can.current }),
}))
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navMock,
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode
    to: string
    params: { id: string }
    className?: string
  }) => (
    <a className={className} href={to.replace("$id", params.id)}>
      {children}
    </a>
  ),
}))

const node = (id: string, name: string, extra = {}) => ({
  id,
  name,
  hidden: false,
  site: null,
  role: null,
  status: null,
  check: null,
  ...extra,
})
const FIBRE = {
  id: "m1",
  name: "Fibre",
  slug: "fibre",
  color: "#f97316",
  text_color: "#000",
  icon: "",
  line_style: "solid",
}
const edge = (id: string, up: string, down: string, extra = {}) => ({
  id,
  upstream: up,
  downstream: down,
  kind: "dependency",
  medium: null,
  redundancy_group: "",
  description: "",
  ...extra,
})

const TREE = {
  root: node("dist", "dist-2"),
  nodes: [
    node("core", "core-1", { check: "up" }),
    node("hidden-1", "Hidden", { hidden: true }),
    node("acc", "acc-7"),
    node("peer", "dist-3"),
  ],
  edges: [
    edge("e1", "core", "dist", { medium: FIBRE, redundancy_group: "uplinks" }),
    edge("e2", "hidden-1", "core"),
    edge("e3", "dist", "acc"),
    edge("e4", "dist", "peer", { kind: "peer" }),
  ],
  depth: 3,
  truncated: { up: false, down: true },
}

const IMPACT = {
  root: [{ id: "dist", name: "dist-2" }],
  devices: [
    {
      id: "acc",
      name: "acc-7",
      level: "outage",
      depth: 1,
      via: [{ id: "dist", name: "dist-2" }],
      site: null,
      rack: null,
    },
  ],
  counts: { outage: 1, reduced_redundancy: 0 },
  truncated: false,
  impacts: [],
}

beforeEach(() => {
  apiMock.mockReset()
  navMock.mockReset()
  can.current = true
  apiMock.mockImplementation(async (path: string) =>
    path.includes("/impact/") ? IMPACT : TREE
  )
})
afterEach(cleanup)

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DeviceDependenciesTab device={{ id: "dist", name: "dist-2" }} />
    </QueryClientProvider>
  )
}

describe("DeviceDependenciesTab", () => {
  it("draws the trees up and down with media, groups and hidden devices", async () => {
    renderTab()
    const core = await screen.findByRole("link", { name: "core-1" })
    expect(apiMock).toHaveBeenCalledWith(
      "/api/devices/dist/dependencies/?depth=3"
    )
    expect(core.getAttribute("href")).toBe("/devices/core")
    const row = core.closest("li")!
    expect(row.textContent).toContain("Fibre")
    expect(row.textContent).toContain("uplinks")
    // core-1's own upstream is a device the caller may not view.
    expect(row.querySelector("li")?.textContent).toContain("Hidden")
    expect(screen.getByRole("link", { name: "acc-7" })).toBeTruthy()
    expect(screen.getByText("More beyond depth 3.")).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "dist-3" }).closest("li")
    ).toBeTruthy()
    expect(screen.getByText("Peers")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Add upstream/ })).toBeTruthy()
  })

  it("warns of upstreams checked less often than the root-cause hold", async () => {
    apiMock.mockImplementation(async (path: string) =>
      path.includes("/impact/")
        ? IMPACT
        : {
            ...TREE,
            hold_seconds: 60,
            slow_upstreams: [
              { id: "core", name: "core-1", interval_seconds: 300 },
            ],
          }
    )
    renderTab()
    const note = await screen.findByText(/Checked less often than the 60s hold/)
    expect(note.textContent).toContain("core-1 (5m)")
  })

  it("says nothing when every upstream answers within the hold", async () => {
    renderTab()
    await screen.findByRole("link", { name: "core-1" })
    expect(screen.queryByText(/Checked less often/)).toBeNull()
  })

  it("hides the add buttons without the grant", async () => {
    can.current = false
    renderTab()
    await screen.findByRole("link", { name: "core-1" })
    expect(screen.queryByRole("button", { name: /Add upstream/ })).toBeNull()
    expect(screen.queryByRole("button", { name: "Edit dependency" })).toBeNull()
  })

  it("answers what if this fails and plans maintenance on it", async () => {
    renderTab()
    await screen.findByRole("link", { name: "core-1" })
    fireEvent.click(screen.getByRole("button", { name: "What if this fails?" }))
    const acc = await screen.findByRole("link", { name: "acc-7" })
    expect(apiMock).toHaveBeenCalledWith("/api/devices/dist/impact/")
    expect(acc.closest("[data-row]")?.textContent).toContain("Outage")
    expect(acc.closest("[data-row]")?.textContent).toContain("via dist-2")
    fireEvent.click(screen.getByRole("button", { name: /Plan maintenance/ }))
    expect(navMock).toHaveBeenCalledWith({
      to: "/maintenance/new",
      search: { affected_kind: "device", affected_id: "dist" },
    })
  })
})
