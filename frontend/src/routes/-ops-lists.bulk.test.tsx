// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { Route as MaintenanceRoute } from "./maintenance.index"
import { Route as DashboardsRoute } from "./dashboards.index"
import { Route as GroupsRoute } from "./groups.index"
import { Route as JobsRoute } from "./jobs.index"
import { Route as OxidizedRoute } from "./oxidized.index"
import {
  bodyOf,
  deleteAnswer,
  mountRoute,
  stubDom,
  tickAll,
} from "./-bulk-list-test-utils"

// Maintenance (Export, Edit, Delete), Dashboards (Delete, the server keeps
// boards shared by others), Groups (Delete only), Jobs (Requeue, Cancel
// after a confirmation) and Oxidized linked nodes (Export, Confirm, Delete).

const { apiMock, can } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  can: { value: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({ apiAll: (p: string) => apiMock(p) }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_t: string, a: string) => a === "view" || can.value,
    can: () => can.value,
    humanIds: false,
  }),
  objCan: (_o: unknown, _a: string, fallback: boolean) => fallback,
}))
vi.mock("@/components/list-page-shell", async () => ({
  ListPageShell: (await import("./-bulk-list-test-utils")).ShellStub,
}))
vi.mock("@/components/table-actions", () => ({ TableActions: () => null }))
vi.mock("@/components/dashboard/dashboard-settings", () => ({
  DashboardSettingsDialog: () => null,
}))

stubDom()

const STAMP = {
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}
const page = <T,>(results: T[]) => ({
  count: results.length,
  next: null,
  results,
})

const EVENTS = ["Alpha", "Bravo"].map((name, i) => ({
  ...STAMP,
  id: `e${i + 1}`,
  kind: "maintenance",
  status: { id: "s1", name: "Confirmed", slug: "confirmed", color: "#888" },
  name,
  description: "",
  provider: null,
  provider_name: null,
  external_ref: "",
  starts_at: "2026-02-01T00:00:00Z",
  ends_at: "2026-02-01T04:00:00Z",
  etr: null,
  raw_email: "",
  impacts: [],
  is_open: true,
}))
const BOARDS = ["Alpha", "Bravo"].map((name, i) => ({
  ...STAMP,
  id: `d${i + 1}`,
  name,
  description: "",
  owner_name: "me",
  mine: i === 1,
  visibility: "tenant",
  groups: [],
  layout: {},
  scope: {},
  frame: "24h",
  refresh_seconds: 0,
}))
const GROUPS = ["Alpha", "Bravo"].map((name, i) => ({
  id: i + 1,
  name,
  description: "",
  built_in: i === 0,
  user_count: 0,
  permission_count: 0,
}))
const JOBS = ["alpha_job", "bravo_job"].map((f, i) => ({
  id: `j${i + 1}`,
  state: "failed",
  queue: "default",
  func_name: f,
  func_short: f,
  description: "",
  corrupt: false,
  enqueued_at: null,
  started_at: null,
  ended_at: null,
  duration: null,
  worker_name: null,
}))
const CONN = {
  id: "c1",
  name: "ox",
  url: "http://ox",
  username: "",
  password_set: false,
  verify_tls: true,
  enabled: true,
  match_by: "address_name",
  auto_sync: false,
  sync_interval_minutes: 15,
  last_checked_at: null,
  last_error: "",
  node_count: 2,
  last_sync_at: null,
  last_sync_attempt_at: null,
  next_sync_at: null,
  link_count: 2,
  sync: {
    nodes: 2,
    linked: 2,
    pinned: 0,
    proposed: 1,
    unmatched_count: 0,
    warning_count: 0,
    missing_pinned: 0,
    error: null,
  },
}
const LINKS = ["core/alpha", "core/bravo"].map((full, i) => ({
  ...STAMP,
  id: `l${i + 1}`,
  connection: "c1",
  connection_name: "ox",
  device: { id: `dev${i}`, name: `sw${i}` },
  virtual_machine: null,
  full_name: full,
  node_name: full.split("/")[1],
  node_group: "core",
  node_ip: "",
  node_model: "ios",
  matched_by: "address",
  proposed: i === 1,
  last_seen_at: null,
}))

function route(path: string) {
  if (path.endsWith("bulk-delete/"))
    return deleteAnswer(["x2"], [{ id: "x1", name: "Alpha", reason: "Kept." }])
  if (path.endsWith("bulk-edit-fields/"))
    return { tags: false, custom_fields: null, fields: [] }
  if (path.startsWith("/api/jobs/bulk-")) return { done: ["j1"], skipped: [] }
  if (path.startsWith("/api/oxidized/links/bulk-confirm/"))
    return { confirmed: ["l2"], skipped: [] }
  if (path.startsWith("/api/monitoring/maintenance-events/"))
    return page(EVENTS)
  if (path.startsWith("/api/dashboards/")) return page(BOARDS)
  if (path.startsWith("/api/groups/")) return page(GROUPS)
  if (path.startsWith("/api/jobs/scheduled/")) return { tasks: [], engines: [] }
  if (path.startsWith("/api/jobs/"))
    return {
      jobs: JOBS,
      total: 2,
      limit: 50,
      offset: 0,
      truncated: false,
      counts: { by_state: { failed: 2, total: 2 }, by_queue: {} },
      workers: [],
      queues: ["default"],
      states: [],
    }
  if (path.startsWith("/api/oxidized/connections/c1/unmatched/"))
    return { results: [], count: 0, warnings: [] }
  if (path.startsWith("/api/oxidized/connections/")) return page([CONN])
  if (path.startsWith("/api/oxidized/links/")) return page(LINKS)
  return page([])
}

const components = [
  MaintenanceRoute,
  DashboardsRoute,
  GroupsRoute,
  JobsRoute,
  OxidizedRoute,
].map((r) => r.options.component)

beforeAll(async () => {
  for (const c of components) {
    const lazy = c as { preload?: () => Promise<void> }
    await lazy.preload?.()
  }
})
beforeEach(() => {
  can.value = true
  apiMock.mockReset()
  apiMock.mockImplementation((path) => Promise.resolve(route(path)))
})
afterEach(cleanup)

describe("the Maintenance list", () => {
  it("offers Export, Edit and a previewed Delete", async () => {
    mountRoute("/maintenance", MaintenanceRoute.options.component)
    const bar = await tickAll("Bravo")
    expect(bar.getByRole("button", { name: /Export/ })).toBeTruthy()
    fireEvent.click(bar.getByRole("button", { name: /^Edit$/ }))
    expect(await screen.findByText("Edit 2 events")).toBeTruthy()
  })

  it("offers no selection without change or delete", async () => {
    can.value = false
    mountRoute("/maintenance", MaintenanceRoute.options.component)
    await screen.findByText("Bravo")
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})

describe("the Dashboards list", () => {
  it("previews a delete that keeps someone else's board", async () => {
    mountRoute("/dashboards", DashboardsRoute.options.component)
    const bar = await tickAll("Bravo")
    expect(bar.queryByRole("button", { name: /Edit/ })).toBeNull()
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Kept.")).toBeTruthy()
    expect(bodyOf(apiMock.mock.calls, "/api/dashboards/bulk-delete/")).toEqual({
      ids: ["d1", "d2"],
      dry_run: true,
    })
  })
})

describe("the Groups list", () => {
  it("offers Delete only, with whole-number ids sent as text", async () => {
    mountRoute("/groups", GroupsRoute.options.component)
    const bar = await tickAll("Bravo")
    expect(bar.queryByRole("button", { name: /Edit/ })).toBeNull()
    expect(bar.queryByRole("button", { name: /Export/ })).toBeNull()
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Kept.")).toBeTruthy()
    expect(bodyOf(apiMock.mock.calls, "/api/groups/bulk-delete/")).toEqual({
      ids: ["1", "2"],
      dry_run: true,
    })
  })

  it("offers no selection without delete", async () => {
    can.value = false
    mountRoute("/groups", GroupsRoute.options.component)
    await screen.findByText("Bravo")
    expect(screen.queryByRole("checkbox", { name: "Select row" })).toBeNull()
  })
})

describe("the Jobs queue", () => {
  async function queueBar() {
    mountRoute("/jobs", JobsRoute.options.component)
    fireEvent.click(await screen.findByRole("button", { name: /^Queue/ }))
    return tickAll("bravo_job")
  }

  it("requeues the ticked jobs", async () => {
    const bar = await queueBar()
    fireEvent.click(bar.getByRole("button", { name: "Requeue" }))
    await waitFor(() =>
      expect(bodyOf(apiMock.mock.calls, "/api/jobs/bulk-requeue/")).toEqual({
        ids: ["j1", "j2"],
      })
    )
  })

  it("cancels only after a confirmation", async () => {
    const bar = await queueBar()
    fireEvent.click(bar.getByRole("button", { name: /Cancel/ }))
    expect(
      apiMock.mock.calls.some(([p]) => p === "/api/jobs/bulk-cancel/")
    ).toBe(false)
    fireEvent.click(await screen.findByRole("button", { name: "Cancel jobs" }))
    await waitFor(() =>
      expect(bodyOf(apiMock.mock.calls, "/api/jobs/bulk-cancel/")).toEqual({
        ids: ["j1", "j2"],
      })
    )
  })
})

describe("the Oxidized linked nodes", () => {
  it("confirms the ticked proposed links and offers Export", async () => {
    mountRoute("/oxidized", OxidizedRoute.options.component)
    const bar = await tickAll("core/bravo")
    expect(bar.getByRole("button", { name: /Export/ })).toBeTruthy()
    fireEvent.click(bar.getByRole("button", { name: /Confirm/ }))
    await waitFor(() =>
      expect(
        bodyOf(apiMock.mock.calls, "/api/oxidized/links/bulk-confirm/")
      ).toEqual({ ids: ["l2"] })
    )
  })

  it("previews an unlink as a safe bulk delete", async () => {
    mountRoute("/oxidized", OxidizedRoute.options.component)
    const bar = await tickAll("core/bravo")
    fireEvent.click(bar.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Kept.")).toBeTruthy()
    expect(
      bodyOf(apiMock.mock.calls, "/api/oxidized/links/bulk-delete/")
    ).toEqual({ ids: ["l1", "l2"], dry_run: true })
  })
})
