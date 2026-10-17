// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { useState } from "react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PlanningOverdueTask, PlanningTask } from "@/lib/api"
import { DetailShell, DetailTab, withTasksTab } from "@/components/detail-shell"
import { ObjectOverdueWarning, ObjectTasksPanel } from "./object-tasks"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const { apiMock, canView } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canView: { value: true },
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: false, datetime: null },
    canDo: (type: string) => (type === "task" ? canView.value : true),
    humanIds: false,
  }),
  objCan: () => true,
}))

const DEVICE = "11111111-2222-3333-4444-555555555555"

const task = (over: Partial<PlanningTask>): PlanningTask =>
  ({
    id: "t1",
    board: "b1",
    board_name: "Ops",
    status: "s1",
    status_name: "In progress",
    status_color: "#f59e0b",
    status_group: "started",
    title: "Swap PSU",
    priority: "high",
    assignee_detail: [{ id: 1, username: "alice", email: "" }],
    assigned_group_name: null,
    due_date: "2026-01-02",
    due_time: null,
    start_date: null,
    ...over,
  }) as PlanningTask

const overdue = (over: Partial<PlanningOverdueTask>): PlanningOverdueTask => ({
  id: "t1",
  board: "b1",
  board_name: "Ops",
  title: "Swap PSU",
  status_name: "In progress",
  status_color: "#f59e0b",
  priority: "high",
  due_date: "2026-01-02",
  due_time: "09:30:00",
  ...over,
})

let answers: Array<[RegExp, unknown]> = []
beforeEach(() => {
  canView.value = true
  answers = [
    [
      /^\/api\/prefs\/columns\//,
      { source: "none", is_forced: false, data: null },
    ],
  ]
  apiMock.mockReset()
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") return Promise.resolve(undefined)
    const hit = answers.find(([re]) => re.test(path))
    return hit ? Promise.resolve(hit[1]) : new Promise(() => undefined)
  })
})
afterEach(cleanup)

function mount(node: ReactNode, at = "/") {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const device = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, device]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
  return router
}

const paged = (rows: PlanningTask[]) => ({
  count: rows.length,
  next: null,
  previous: null,
  results: rows,
})

describe("withTasksTab", () => {
  it("goes before Journal and Change log", () => {
    const tabs = withTasksTab(
      [
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ],
      2
    )
    expect(tabs.map((t) => t.value)).toEqual([
      "overview",
      "tasks",
      "journal",
      "history",
    ])
    expect(tabs[1].count).toBe(2)
  })

  it("goes last on a page without Journal, and never twice", () => {
    const once = withTasksTab([{ value: "overview", label: "Overview" }], 0)
    expect(once.map((t) => t.value)).toEqual(["overview", "tasks"])
    expect(withTasksTab(once, 0)).toHaveLength(2)
  })
})

describe("ObjectTasksPanel", () => {
  it("lists open linked tasks with the status as its pill", async () => {
    answers.push([
      /^\/api\/planning\/tasks\/\?object_type=api.device&object_id=.*&open=1$/,
      paged([task({})]),
    ])
    mount(<ObjectTasksPanel objectType="api.device" objectId={DEVICE} />)
    const link = await screen.findByRole("link", { name: "Swap PSU" })
    expect(link.getAttribute("href")).toBe("/planning/b1/tasks/t1")
    const pill = screen.getByText("In progress")
    expect(pill.closest("[data-slot=badge]")).not.toBeNull()
    expect(screen.getByText("alice")).toBeTruthy()
    expect(screen.getByText("High")).toBeTruthy()
  })

  it("All includes done tasks; Open shows an empty state when none", async () => {
    answers.push([/&open=1$/, paged([])])
    answers.push([
      /object_id=[^&]*$/,
      paged([task({ status_name: "Done", status_group: "completed" })]),
    ])
    mount(<ObjectTasksPanel objectType="api.device" objectId={DEVICE} />)
    expect(await screen.findByText("No open tasks.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "All" }))
    expect(await screen.findByText("Done")).toBeTruthy()
    const paths = apiMock.mock.calls.map(([p]) => p)
    expect(paths.some((p) => p.endsWith(`object_id=${DEVICE}`))).toBe(true)
  })
})

describe("ObjectOverdueWarning", () => {
  it("renders nothing when the server reports nothing overdue for me", async () => {
    answers.push([/^\/api\/planning\/tasks\/overdue\//, []])
    mount(<ObjectOverdueWarning objectType="api.device" objectId={DEVICE} />)
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) =>
          p.startsWith("/api/planning/tasks/overdue/")
        )
      ).toBe(true)
    )
    expect(screen.queryByText("Overdue")).toBeNull()
  })

  it("shows the overdue task and dismisses it server-side", async () => {
    answers.push([/^\/api\/planning\/tasks\/overdue\//, [overdue({})]])
    mount(<ObjectOverdueWarning objectType="api.device" objectId={DEVICE} />)
    expect(await screen.findByText("Overdue")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Swap PSU" })).toBeTruthy()
    expect(screen.getByText(/09:30/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Swap PSU" }))
    await waitFor(() => expect(screen.queryByText("Overdue")).toBeNull())
    expect(apiMock).toHaveBeenCalledWith(
      "/api/planning/tasks/t1/dismiss-overdue/",
      expect.objectContaining({ method: "POST" })
    )
  })
})

function Page() {
  const [tab, setTab] = useState("overview")
  return (
    <DetailShell
      backTo="/"
      backLabel="Devices"
      title="sw1"
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">overview body</DetailTab>
    </DetailShell>
  )
}

describe("DetailShell on an object page", () => {
  it("adds a counted Tasks tab before Journal and opens it", async () => {
    answers.push([/&open=1$/, paged([task({})])])
    answers.push([/^\/api\/planning\/tasks\/overdue\//, []])
    const router = mount(<Page />, `/devices/${DEVICE}`)
    const strip = (await screen.findByText("Journal")).closest("nav")!
    await waitFor(() =>
      expect(strip.textContent).toBe("OverviewTasks1JournalChange log")
    )
    fireEvent.click(screen.getByRole("button", { name: /^Tasks/ }))
    expect(await screen.findByRole("link", { name: "Swap PSU" })).toBeTruthy()
    expect((router.state.location.search as Record<string, unknown>).tab).toBe(
      "tasks"
    )
  })

  it("has no Tasks tab without task view rights", async () => {
    canView.value = false
    mount(<Page />, `/devices/${DEVICE}`)
    const strip = (await screen.findByText("Journal")).closest("nav")!
    expect(strip.textContent).toBe("OverviewJournalChange log")
    expect(
      apiMock.mock.calls.some(([p]) => p.startsWith("/api/planning/tasks/"))
    ).toBe(false)
  })

  it("has no Tasks tab off an object page", async () => {
    mount(<Page />)
    const strip = (await screen.findByText("Journal")).closest("nav")!
    expect(strip.textContent).toBe("OverviewJournalChange log")
  })
})
