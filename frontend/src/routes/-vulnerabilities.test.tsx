// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
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

import type { VulnRecordDetail, VulnRecordRow } from "@/lib/api"
import { Route as ListRoute } from "./vulnerabilities.index"
import { Route as DetailRoute, cweUrl } from "./vulnerabilities.$id"

// The Vulnerabilities page and a record's page (#451): off → the empty
// state (with the settings link for a deployment admin); on → the server's
// rows with the rail's facets sent as f_<facet> from the URL; a record's
// Overview with its facts and outbound references, and its Affected tab.

const { apiMock, settings } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  settings: { value: { enabled: true, can_manage: true } },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: () => true,
    can: () => true,
    humanIds: false,
  }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({
    title,
    rail,
    actions,
    children,
  }: {
    title: string
    rail?: ReactNode
    actions?: ReactNode
    children: ReactNode
  }) => (
    <div>
      <h1>{title}</h1>
      {actions}
      {rail}
      {children}
    </div>
  ),
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
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const ROW: VulnRecordRow = {
  id: "CVE-2023-20198",
  vuln_id: "CVE-2023-20198",
  aliases: [],
  summary: "Web UI privilege escalation",
  published: "2023-10-16T00:00:00Z",
  cvss_version: "3.1",
  cvss_score: "10.0",
  cvss_severity: "critical",
  attack_vector: "network",
  kev: true,
  kev_added: "2023-10-16",
  kev_due: "2023-10-20",
  epss: "0.94372",
  epss_percentile: "0.99960",
  analysed: true,
  priority: "fix_first",
  devices: 12,
  virtual_machines: 1,
  installs: 0,
  matches: 13,
  excepted: 0,
  first_seen_at: "2026-11-01T00:00:00Z",
}

const DETAIL: VulnRecordDetail = {
  ...ROW,
  last_modified: "2024-01-01T00:00:00Z",
  vuln_status: "Analyzed",
  rejected: false,
  cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H",
  cvss_verified: true,
  cwes: ["CWE-420"],
  references: [
    { url: "https://sec.example.com/advisory", tags: ["Vendor Advisory"] },
  ],
  fixed_in: [
    { part: "o", vendor: "cisco", product: "ios_xe", version: "17.9.4a" },
  ],
  osv_fixed_in: [],
  kev_action: "Apply the vendor fix.",
  kev_ransomware: "unknown",
  epss_date: "2026-11-09",
  source: "nvd_api",
  fetched_at: "2026-11-09T05:50:00Z",
  priority: "fix_first",
  affected_count: 13,
  excepted_count: 0,
  affected: [],
}

beforeAll(async () => {
  for (const r of [ListRoute, DetailRoute]) {
    const lazy = r.options.component as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
beforeEach(() => {
  settings.value = { enabled: true, can_manage: true }
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/vulnerabilities/settings/"))
      return Promise.resolve(settings.value)
    if (path.startsWith("/api/vulnerabilities/facets/"))
      return Promise.resolve({
        facets: {
          priority: [{ value: "fix_first", label: "Fix first", count: 1 }],
          severity: [{ value: "critical", label: "Critical", count: 1 }],
          kev: [{ value: "yes", label: "Known exploited", count: 1 }],
          first_seen: [],
          epss: [],
          site: [],
          platform: [],
          application: [],
        },
        sortable: ["priority", "score"],
      })
    if (path.startsWith("/api/vulnerabilities/matches/"))
      return Promise.resolve({ count: 0, results: [], next: null })
    if (path.startsWith("/api/vulnerabilities/CVE-2023-20198/"))
      return Promise.resolve(DETAIL)
    if (path.startsWith("/api/vulnerabilities/?"))
      return Promise.resolve({ count: 1, results: [ROW], next: null })
    return Promise.resolve({ count: 0, results: [], next: null })
  })
})
afterEach(cleanup)

function mount(url: string) {
  const root = createRootRoute()
  const list = createRoute({
    getParentRoute: () => root,
    path: "/vulnerabilities",
    component: ListRoute.options.component,
  })
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/vulnerabilities/$id",
    component: DetailRoute.options.component,
  })
  const router = createRouter({
    routeTree: root.addChildren([list, detail]),
    history: createMemoryHistory({ initialEntries: [url] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

const calls = () => apiMock.mock.calls.map((c) => c[0])

describe("the Vulnerabilities page", () => {
  it("says the feature is off, with the way to turn it on", async () => {
    settings.value = { enabled: false, can_manage: true }
    mount("/vulnerabilities")
    expect(await screen.findByText("Vulnerability data is off")).toBeTruthy()
    expect(
      screen.getByText("Settings → General → Vulnerability data")
    ).toBeTruthy()
    expect(calls().some((p) => p.startsWith("/api/vulnerabilities/?"))).toBe(
      false
    )
  })

  it("asks the server with the URL's facets and lists its rows", async () => {
    mount("/vulnerabilities?priority=fix_first&kev=yes&q=web")
    expect(await screen.findByText("CVE-2023-20198")).toBeTruthy()
    await waitFor(() => {
      const page = calls().find((p) => p.startsWith("/api/vulnerabilities/?"))
      expect(page).toBeTruthy()
      const params = new URLSearchParams(page!.split("?")[1])
      expect(params.get("f_priority")).toBe("fix_first")
      expect(params.get("f_kev")).toBe("yes")
      expect(params.get("search")).toBe("web")
    })
    expect(screen.getByText("By object")).toBeTruthy()
  })

  it("asks the match list in the By object view", async () => {
    mount("/vulnerabilities?view=objects")
    await waitFor(() =>
      expect(
        calls().some((p) => p.startsWith("/api/vulnerabilities/matches/?"))
      ).toBe(true)
    )
  })
})

describe("a record's page", () => {
  it("shows the record's facts and links out safely", async () => {
    mount("/vulnerabilities/CVE-2023-20198")
    expect(await screen.findByText("Web UI privilege escalation")).toBeTruthy()
    expect(screen.getByText(DETAIL.cvss_vector)).toBeTruthy()
    expect(screen.getByText("17.9.4a")).toBeTruthy()
    const ref = screen
      .getByText("https://sec.example.com/advisory")
      .closest("a")
    expect(ref?.getAttribute("rel")).toContain("noopener")
    expect(ref?.getAttribute("target")).toBe("_blank")
    const cwe = screen.getByText("CWE-420").closest("a")
    expect(cwe?.getAttribute("href")).toBe(cweUrl("CWE-420"))
    expect(screen.queryByText("Journal")).toBeNull()
    expect(screen.queryByText("Change log")).toBeNull()
  })

  it("lists what it affects on the Affected tab", async () => {
    mount("/vulnerabilities/CVE-2023-20198?tab=affected")
    await waitFor(() =>
      expect(
        calls().some((p) =>
          p.startsWith(
            "/api/vulnerabilities/matches/?cve=CVE-2023-20198&status=all&excepted=all"
          )
        )
      ).toBe(true)
    )
    expect(await screen.findByText("Nothing affected")).toBeTruthy()
  })
})
