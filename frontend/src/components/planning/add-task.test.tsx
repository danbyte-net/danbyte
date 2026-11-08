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

import type { PlanningTask } from "@/lib/api"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ObjectTasksPanel } from "./object-tasks"
import { PlanFromObject } from "./plan-from-object"
import { AddTaskButton } from "./add-task"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
// Radix popovers (the board combobox, the assignee picker) scroll into view.
if (!("scrollIntoView" in Element.prototype))
  (Element.prototype as unknown as Record<string, unknown>).scrollIntoView =
    () => {}

const { apiMock, denied, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  denied: new Set<string>(),
  toastMock: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("sonner", async (orig) => ({
  ...(await orig<object>()),
  toast: toastMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {
      username: "alice",
      perms: [],
      permissions: {},
      is_superuser: false,
      datetime: null,
    },
    canDo: (type: string, action: string) => !denied.has(`${type}.${action}`),
    humanIds: false,
  }),
  objCan: () => true,
}))

const DEVICE = "11111111-2222-3333-4444-555555555555"

const task = (over: Partial<PlanningTask>): PlanningTask =>
  ({
    id: "t9",
    board: "b2",
    board_name: "Ops",
    status: "s1",
    status_name: "To do",
    status_color: "#64748b",
    status_group: "unstarted",
    title: "Swap PSU",
    priority: "none",
    assignee_detail: [],
    assigned_group_name: null,
    due_date: null,
    due_time: null,
    start_date: null,
    weight: 100,
    ...over,
  }) as PlanningTask

const paged = <T,>(rows: T[]) => ({
  count: rows.length,
  next: null,
  previous: null,
  results: rows,
})

// Linked tasks the server knows about - a POST to /links/ adds to it, so a
// refetch after the create sees the new task.
let linked: PlanningTask[] = []
let posts: Array<[string, Record<string, unknown>]> = []

beforeEach(() => {
  denied.clear()
  linked = []
  posts = []
  toastMock.success.mockReset()
  apiMock.mockReset()
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push([path, body])
      if (path === "/api/planning/tasks/")
        return Promise.resolve(
          task({ board: body.board as string, title: body.title as string })
        )
      if (path === "/api/planning/links/") {
        linked = [...linked, task({ title: posts[0][1].title as string })]
        return Promise.resolve({})
      }
      return Promise.resolve({})
    }
    if (path.startsWith("/api/prefs/columns/"))
      return Promise.resolve({ source: "none", is_forced: false, data: null })
    if (path.startsWith("/api/planning/tasks/overdue/"))
      return Promise.resolve([])
    if (path.startsWith("/api/planning/tasks/?object_type="))
      return Promise.resolve(paged(linked))
    if (path.startsWith("/api/planning/tasks/?"))
      return Promise.resolve(paged([]))
    if (path === "/api/planning/boards/")
      return Promise.resolve(
        paged([
          { id: "b2", name: "Ops" },
          { id: "b3", name: "DC move" },
        ])
      )
    if (path.startsWith("/api/planning/statuses/?board="))
      return Promise.resolve(
        paged([
          { id: "s0", semantic_group: "completed" },
          { id: "s1", semantic_group: "unstarted" },
        ])
      )
    if (path.startsWith("/api/planning/assignable-"))
      return Promise.resolve({ results: [] })
    return new Promise(() => undefined)
  })
})
afterEach(cleanup)

function mount(node: ReactNode, at = `/devices/${DEVICE}`) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const device = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id",
    component: () => <>{node}</>,
  })
  const edit = createRoute({
    getParentRoute: () => root,
    path: "/devices/$id/edit",
    component: () => <p>edit form</p>,
  })
  const router = createRouter({
    routeTree: root.addChildren([device, edit]),
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

async function addTask(title: string, board = "Ops") {
  fireEvent.click(await screen.findByRole("button", { name: "Add task" }))
  const dialog = await screen.findByRole("dialog")
  fireEvent.change(dialog.querySelector("input")!, {
    target: { value: title },
  })
  // Without a default, the first board - as "Plan a change" does.
  await waitFor(() => expect(dialog.textContent).toContain(board))
  const save = screen
    .getAllByRole("button", { name: "Add task" })
    .find((b) => dialog.contains(b))!
  await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false))
  fireEvent.click(save)
}

describe("Add task on an object's Tasks tab", () => {
  it("is hidden without the right to add tasks", async () => {
    denied.add("task.add")
    mount(<ObjectTasksPanel objectType="api.device" objectId={DEVICE} />)
    expect(await screen.findByText("No open tasks.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add task" })).toBeNull()
  })

  it("is hidden without the right to link the task", async () => {
    denied.add("tasklink.add")
    mount(<ObjectTasksPanel objectType="api.device" objectId={DEVICE} />)
    expect(await screen.findByText("No open tasks.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Add task" })).toBeNull()
  })

  it("creates the task, links this object and refreshes the list", async () => {
    mount(<ObjectTasksPanel objectType="api.device" objectId={DEVICE} />)
    expect(await screen.findByText("No open tasks.")).toBeTruthy()
    await addTask("Replace fan tray")

    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[0]).toEqual([
      "/api/planning/tasks/",
      { board: "b2", status: "s1", title: "Replace fan tray" },
    ])
    expect(posts[1]).toEqual([
      "/api/planning/links/",
      { task: "t9", object_type: "api.device", object_id: DEVICE },
    ])
    const link = await screen.findByRole("link", { name: "Replace fan tray" })
    expect(link.getAttribute("href")).toBe("/planning/b2/tasks/t9")
    expect(toastMock.success).toHaveBeenCalledWith(
      "Created Replace fan tray",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Open" }),
      })
    )
    // The dialog closes; the operator stays on the object.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
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
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">overview body</DetailTab>
    </DetailShell>
  )
}

describe("Add task in DetailShell", () => {
  it("updates the Tasks tab count after adding", async () => {
    mount(<Page />, `/devices/${DEVICE}?tab=tasks`)
    const strip = (await screen.findByText("Journal")).closest("nav")!
    await waitFor(() => expect(strip.textContent).toBe("OverviewTasksJournal"))
    await addTask("Replace fan tray")
    await waitFor(() => expect(strip.textContent).toBe("OverviewTasks1Journal"))
  })
})

describe("Add task without an object (calendar)", () => {
  it("starts on the given board and day and links nothing", async () => {
    denied.add("tasklink.add")
    mount(<AddTaskButton defaultBoard="b3" defaultDueDate="2026-11-02" />)
    await addTask("Patch window", "DC move")
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0]).toEqual([
      "/api/planning/tasks/",
      {
        board: "b3",
        status: "s1",
        title: "Patch window",
        due_date: "2026-11-02",
      },
    ])
  })
})

describe("PlanFromObject with the shared create", () => {
  it("creates and links a task, then opens the edit form in plan mode", async () => {
    const router = mount(<PlanFromObject />)
    fireEvent.click(
      await screen.findByRole("button", { name: /Plan a change/ })
    )
    fireEvent.change(
      await screen.findByPlaceholderText("Which task is this for?"),
      { target: { value: "Re-cable uplinks" } }
    )
    fireEvent.click(await screen.findByRole("button", { name: /New task/ }))
    const save = await screen.findByRole("button", { name: "Create & plan" })
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false))
    fireEvent.click(save)

    await waitFor(() => expect(posts).toHaveLength(2))
    expect(posts[0]).toEqual([
      "/api/planning/tasks/",
      { board: "b2", status: "s1", title: "Re-cable uplinks" },
    ])
    expect(posts[1][1]).toEqual({
      task: "t9",
      object_type: "api.device",
      object_id: DEVICE,
    })
    expect(toastMock.success).toHaveBeenCalledWith("Task created")
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/devices/${DEVICE}/edit`)
    )
    expect(router.state.location.search).toEqual({
      plan: "t9",
      planBoard: "b2",
    })
  })

  it("offers no New task without the right to add tasks", async () => {
    denied.add("task.add")
    mount(<PlanFromObject />)
    fireEvent.click(
      await screen.findByRole("button", { name: /Plan a change/ })
    )
    expect(await screen.findByText("No tasks yet.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: /New task/ })).toBeNull()
  })
})
