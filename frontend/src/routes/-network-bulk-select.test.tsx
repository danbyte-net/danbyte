// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
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

import { Route as Certificates } from "./certificates.index"
import { Route as CertificateRequests } from "./certificate-requests.index"
import { Route as Issuers } from "./certificate-issuers.index"
import { Route as DhcpLeases } from "./dhcp-leases.index"
import { Route as DhcpReservations } from "./dhcp-reservations.index"
import { Route as DhcpScopes } from "./dhcp-scopes.index"
import { Route as DnsZones } from "./dns-zones.index"
import { Route as L2vpns } from "./l2vpns.index"
import { Route as VirtualSwitches } from "./virtual-switches.index"
import { Route as VirtualizationSources } from "./virtualization-sources.index"
import { Route as WindowsServers } from "./windows-servers.index"

// The certificate, DHCP, DNS, L2VPN and virtualization lists: with a change
// or delete grant the rows tick, and the bar that floats up offers Export of
// the selection plus the bulk Edit and Delete each list's API takes - leases
// export only, reservations and switches leave out what their single page
// does not do. Without the grants, no selection.

const { apiMock, can } = vi.hoisted(() => {
  const grant: { value: boolean | "view" } = { value: true }
  return {
    apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
    can: grant,
  }
})
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_t: string, a: string) =>
      can.value === true || (can.value === "view" && a === "view"),
    humanIds: false,
  }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    rail,
    children,
  }: {
    rail?: ReactNode
    children: ReactNode
  }) => (
    <div>
      {rail}
      {children}
    </div>
  ),
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const T = "2026-01-01T00:00:00Z"
const base = (id: string) => ({ id, created_at: T, updated_at: T })

const cert = (id: string, cn: string) => ({
  ...base(id),
  fingerprint_sha256: id.repeat(8),
  subject: `CN=${cn}`,
  subject_cn: cn,
  issuer: "CN=CA",
  issuer_cn: "CA",
  is_expired: false,
  days_until_expiry: 90,
  public_key_algorithm: "rsa",
  public_key_bits: 2048,
  self_signed: false,
  is_ca: false,
  origin: "uploaded",
  binding_count: 0,
  assignment_count: 0,
  last_seen: null,
})
const request = (id: string, cn: string) => ({
  ...base(id),
  common_name: cn,
  key_spec: "rsa-2048",
  key_spec_display: "RSA 2048",
  status: "generated",
  status_display: "Generated",
  issued_certificate: null,
})
const issuer = (id: string, name: string) => ({
  ...base(id),
  name,
  kind: "acme",
  enabled: true,
  directory_url: "https://acme.example/dir",
  contact_email: "",
  account_registered: false,
  dns_provider: "",
  verify_tls: true,
})
const lease = (id: string, ip: string) => ({
  ...base(id),
  scope: "s1",
  scope_display: "10.0.0.0",
  ip,
  mac: "aa:bb:cc:00:00:01",
  hostname: "",
  address_state: "Active",
  expires_at: null,
  ip_address: null,
})
const reservation = (id: string, ip: string) => ({
  ...base(id),
  scope: "s1",
  scope_display: "10.0.0.0",
  scope_prefix: null,
  connection: null,
  connection_name: null,
  ip,
  mac: "aa:bb:cc:00:00:01",
  name: "",
  description: "",
  ip_address: null,
  managed: true,
  drift: "",
})
const scope = (id: string, sid: string) => ({
  ...base(id),
  connection: null,
  connection_name: null,
  scope_id: sid,
  name: "",
  state: "Active",
  start_range: "10.0.0.10",
  end_range: "10.0.0.20",
  prefix: null,
  prefix_cidr: null,
  vrf_name: null,
  lease_sync: false,
  reservation_count: 0,
  drift_count: 0,
})
const zone = (id: string, name: string) => ({
  ...base(id),
  connection: null,
  connection_name: "",
  name,
  zone_type: "Primary",
  is_reverse: false,
  sync: false,
  auto_create: false,
  managed: true,
  record_count: 0,
  drift_count: 0,
})
const l2vpn = (id: string, name: string) => ({
  ...base(id),
  numid: 1,
  name,
  slug: name.toLowerCase(),
  type: "vxlan",
  type_display: "VXLAN",
  identifier: 100,
  vrf: null,
  status: null,
  import_targets: [],
  export_targets: [],
  tags: [],
  description: "",
  termination_count: 0,
  vtep_count: 0,
})
const vswitch = (id: string, name: string) => ({
  ...base(id),
  name,
  kind: "linux-bridge",
  kind_display: "Linux bridge",
  cluster: null,
  uplinks: "",
  uplink_interfaces: [],
  mtu: null,
  vrf: null,
  description: "",
})
const source = (id: string, name: string) => ({
  ...base(id),
  name,
  kind: "proxmox",
  kind_display: "Proxmox VE",
  host: "10.0.0.11",
  port: 8006,
  sync_mode: "review",
  pending_count: 0,
  enabled: true,
  last_sync_status: "",
  last_sync_error: "",
  last_sync_skipped: [],
  last_sync_at: null,
})
const server = (id: string, name: string) => ({
  ...base(id),
  name,
  host: "10.0.0.20",
  port: 5985,
  dhcp_enabled: true,
  dns_enabled: false,
  enabled: true,
  last_sync_status: "",
  last_sync_error: "",
  last_sync_skipped: [],
  last_sync_at: null,
})

interface Case {
  name: string
  route: { options: { component?: RouteComponent } }
  path: string
  endpoint: string
  rows: [unknown, unknown]
  labels: [string, string]
  edit: boolean
  del: boolean
  /** Selection with a view grant alone (an export-only list). */
  viewSelects?: boolean
}

const CASES: Case[] = [
  {
    name: "certificates",
    route: Certificates,
    path: "/certificates",
    endpoint: "/api/monitoring/certificates/",
    rows: [cert("c1", "a.example"), cert("c2", "b.example")],
    labels: ["a.example", "b.example"],
    edit: true,
    del: true,
  },
  {
    name: "certificate requests",
    route: CertificateRequests,
    path: "/certificate-requests",
    endpoint: "/api/monitoring/certificate-requests/",
    rows: [request("r1", "a.example"), request("r2", "b.example")],
    labels: ["a.example", "b.example"],
    edit: true,
    del: true,
  },
  {
    name: "certificate issuers",
    route: Issuers,
    path: "/certificate-issuers",
    endpoint: "/api/monitoring/issuers/",
    rows: [issuer("i1", "LE"), issuer("i2", "step")],
    labels: ["LE", "step"],
    edit: true,
    del: true,
  },
  {
    name: "DHCP leases",
    route: DhcpLeases,
    path: "/dhcp-leases",
    endpoint: "/api/dhcp-leases/",
    rows: [lease("l1", "10.0.0.11"), lease("l2", "10.0.0.12")],
    labels: ["10.0.0.11", "10.0.0.12"],
    edit: false,
    del: false,
    viewSelects: true,
  },
  {
    name: "DHCP reservations",
    route: DhcpReservations,
    path: "/dhcp-reservations",
    endpoint: "/api/dhcp-reservations/",
    rows: [reservation("v1", "10.0.0.31"), reservation("v2", "10.0.0.32")],
    labels: ["10.0.0.31", "10.0.0.32"],
    edit: false,
    del: true,
  },
  {
    name: "DHCP scopes",
    route: DhcpScopes,
    path: "/dhcp-scopes",
    endpoint: "/api/dhcp-scopes/",
    rows: [scope("s1", "10.0.0.0"), scope("s2", "10.0.1.0")],
    labels: ["10.0.0.0", "10.0.1.0"],
    edit: true,
    del: true,
  },
  {
    name: "DNS zones",
    route: DnsZones,
    path: "/dns-zones",
    endpoint: "/api/dns-zones/",
    rows: [zone("z1", "a.lan"), zone("z2", "b.lan")],
    labels: ["a.lan", "b.lan"],
    edit: true,
    del: true,
  },
  {
    name: "L2VPNs",
    route: L2vpns,
    path: "/l2vpns",
    endpoint: "/api/l2vpns/",
    rows: [l2vpn("p1", "Blue"), l2vpn("p2", "Red")],
    labels: ["Blue", "Red"],
    edit: true,
    del: true,
  },
  {
    name: "virtual switches",
    route: VirtualSwitches,
    path: "/virtual-switches",
    endpoint: "/api/virtual-switches/",
    rows: [vswitch("w1", "vmbr0"), vswitch("w2", "vmbr1")],
    labels: ["vmbr0", "vmbr1"],
    edit: true,
    del: false,
  },
  {
    name: "virtualization sources",
    route: VirtualizationSources,
    path: "/virtualization-sources",
    endpoint: "/api/virtualization-sources/",
    rows: [source("x1", "pve1"), source("x2", "pve2")],
    labels: ["pve1", "pve2"],
    edit: true,
    del: true,
  },
  {
    name: "Windows servers",
    route: WindowsServers,
    path: "/windows-servers",
    endpoint: "/api/windows-connections/",
    rows: [server("n1", "dc1"), server("n2", "dc2")],
    labels: ["dc1", "dc2"],
    edit: true,
    del: true,
  },
]

let current: Case = CASES[0]

beforeAll(async () => {
  for (const c of CASES) {
    const lazy = c.route.options.component as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
beforeEach(() => {
  can.value = true
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.endsWith("bulk-delete/"))
      return Promise.resolve({
        deleted: 1,
        deleted_ids: [(current.rows[1] as { id: string }).id],
        skipped: [
          {
            id: (current.rows[0] as { id: string }).id,
            name: current.labels[0],
            reason: "Kept for the test.",
          },
        ],
        impact: [],
        released: [],
        dry_run: true,
      })
    if (path.endsWith("bulk-edit-fields/"))
      return Promise.resolve({ tags: false, custom_fields: null, fields: [] })
    if (path.startsWith(current.endpoint))
      return Promise.resolve({
        count: current.rows.length,
        results: current.rows,
        next: null,
      })
    return Promise.resolve({ count: 0, results: [], next: null })
  })
})
afterEach(cleanup)

function mount(c: Case) {
  current = c
  const root = createRootRoute()
  const page = createRoute({
    getParentRoute: () => root,
    path: c.path,
    component: c.route.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: [c.path] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

/** Tick every row; the selection bar that floats up. */
async function tickAll(c: Case) {
  await screen.findByText(c.labels[1])
  const boxes = screen.getAllByRole("checkbox", { name: "Select row" })
  expect(boxes).toHaveLength(2)
  for (const box of boxes) fireEvent.click(box)
  const clear = await screen.findByRole("button", { name: "Clear selection" })
  return within(clear.parentElement!)
}

describe.each(CASES)("the $name list", (c) => {
  beforeEach(() => {
    // The reservations list reads its `?scope=` through its file route.
    if (c.route === DhcpReservations)
      vi.spyOn(DhcpReservations, "useSearch").mockReturnValue({
        scope: undefined,
      })
  })

  it("offers the bulk actions the list takes", async () => {
    mount(c)
    const bar = await tickAll(c)
    expect(bar.getByRole("button", { name: /Export/ })).toBeTruthy()
    expect(bar.queryByRole("button", { name: /Edit/ }) !== null).toBe(c.edit)
    expect(bar.queryByRole("button", { name: /Delete/ }) !== null).toBe(c.del)
  })

  if (c.del)
    it("previews a bulk delete and names the row kept", async () => {
      mount(c)
      const bar = await tickAll(c)
      fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
      expect(await screen.findByText("Kept for the test.")).toBeTruthy()
      const call = apiMock.mock.calls.find(([p]) => p.endsWith("bulk-delete/"))!
      expect(call[0]).toBe(`${c.endpoint}bulk-delete/`)
      expect(JSON.parse(String(call[1]?.body)).dry_run).toBe(true)
    })

  if (c.edit)
    it("opens the bulk edit with the server's fields", async () => {
      mount(c)
      const bar = await tickAll(c)
      fireEvent.click(bar.getByRole("button", { name: /Edit/ }))
      await waitFor(() =>
        expect(
          apiMock.mock.calls.some(
            ([p]) => p === `${c.endpoint}bulk-edit-fields/`
          )
        ).toBe(true)
      )
    })

  it("offers no selection without the grants", async () => {
    can.value = c.viewSelects ? false : "view"
    mount(c)
    await screen.findByText(c.labels[1])
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})
