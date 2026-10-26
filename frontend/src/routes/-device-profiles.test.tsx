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
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { DeviceProfile, DeviceProfileAssignment } from "@/lib/api"
import { DeviceProfilesPage } from "./device-profiles.index"
import { AssignedObjects, ProfileOverview } from "./device-profiles.$id"
import {
  DeviceProfileForm,
  applicableFields,
  excludedParents,
} from "@/components/device-profile-form"

// Device profiles: the list, the Overview's effective sections with the
// items inherited from a parent marked, the Assigned objects tab with each
// object's state and Re-apply, and the editor's section cards and parent
// picker that leaves out the profile and its descendants.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    can: () => true,
    humanIds: false,
  }),
  objCan: () => true,
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

const page = <T,>(results: T[]) => ({ count: results.length, results })

/** The table row a text sits in (the facet rail names the same things). */
async function rowOf(text: string): Promise<HTMLElement> {
  const all = await screen.findAllByText(text)
  const row = all.map((e) => e.closest("tr")).find(Boolean)
  if (!row) throw new Error(`no row with ${text}`)
  return row
}

function profile(over: Partial<DeviceProfile> = {}): DeviceProfile {
  return {
    id: "p1",
    numid: 1,
    name: "RDS",
    slug: "rds",
    color: "#10b981",
    path: "RDS",
    description: "",
    parent: null,
    applies_to_devices: true,
    applies_to_vms: true,
    platform: null,
    runbook_url: "",
    notes: "",
    application_groups: [],
    add_tags: [],
    cf_values: {},
    tags: [],
    custom_fields: {},
    assignment_count: 0,
    child_count: 0,
    effective: null,
    created_at: "2026-10-25T10:00:00Z",
    updated_at: "2026-10-25T10:00:00Z",
    ...over,
  }
}

const BASE = profile()
const HR = profile({
  id: "p2",
  name: "RDS HR",
  slug: "rds-hr",
  color: "",
  path: "RDS / RDS HR",
  parent: { id: "p1", name: "RDS", slug: "rds", color: "#10b981" },
  applies_to_vms: false,
  application_groups: [{ id: "g1", name: "Office", slug: "office" }],
  assignment_count: 3,
})
const NIGHT = profile({
  id: "p3",
  name: "RDS HR Night",
  slug: "rds-hr-night",
  path: "RDS / RDS HR / RDS HR Night",
  parent: { id: "p2", name: "RDS HR", slug: "rds-hr", color: "" },
})
const OTHER = profile({ id: "p4", name: "Web", slug: "web", path: "Web" })

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/prefs/columns/"))
      return { source: "none", is_forced: false, data: null }
    if (path.startsWith("/api/device-profiles/"))
      return page([BASE, HR, NIGHT, OTHER])
    return page([])
  })
})
afterEach(cleanup)

function mount(node: ReactNode) {
  const root = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

describe("the device profiles list", () => {
  it("lists profiles with their parent, what they apply to and counts", async () => {
    mount(<DeviceProfilesPage />)
    const row = await rowOf("RDS HR Night")
    // The chain above the parent, then the parent as a link.
    expect(within(row).getByText(/RDS ›/)).toBeTruthy()
    expect(within(row).getByRole("link", { name: "RDS HR" })).toBeTruthy()
    const hr = (await screen.findAllByRole("link", { name: "RDS HR" }))
      .map((e) => e.closest("tr")!)
      .find((tr) => within(tr).queryByText("Devices"))!
    expect(within(hr).getByText("Devices")).toBeTruthy()
    expect(within(hr).getByText("3")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/device-profiles/?search=")
  })
})

describe("the profile Overview", () => {
  it("shows each section's effective items, inherited ones marked", async () => {
    mount(
      <ProfileOverview
        profile={profile({
          ...HR,
          effective: {
            application_group: [
              { label: "Desk", from: "RDS", inherited: true },
              { label: "Office", from: "RDS HR", inherited: false },
            ],
            tag: [],
            custom_field: [
              { label: "owner", from: "RDS HR", inherited: false, value: "HR" },
            ],
            platform: [{ label: "Windows", from: "RDS", inherited: true }],
          },
        })}
      />
    )
    const groups = (await screen.findByText("Application groups")).closest(
      "section"
    )!
    expect(within(groups).getByText("Desk")).toBeTruthy()
    expect(within(groups).getByText("from RDS")).toBeTruthy()
    expect(within(groups).getByText("Office")).toBeTruthy()
    expect(within(groups).getAllByText(/^from /)).toHaveLength(1)
    const cf = screen.getByText("Custom field values").closest("section")!
    expect(within(cf).getByText("owner")).toBeTruthy()
    expect(within(cf).getByText("HR")).toBeTruthy()
    const platform = screen.getByText("Platform").closest("section")!
    expect(within(platform).getByText("from RDS")).toBeTruthy()
    const tags = screen.getByText("Tags to add").closest("section")!
    expect(within(tags).getByText("None.")).toBeTruthy()
  })
})

const assignment = (
  over: Partial<DeviceProfileAssignment>
): DeviceProfileAssignment => ({
  id: "a1",
  profile: { id: "p2", name: "RDS HR", slug: "rds-hr", color: "" },
  device: { id: "d1", name: "rds1" },
  virtual_machine: null,
  position: 0,
  state: "ok",
  missing_count: 0,
  edited_count: 0,
  reconciled_at: null,
  created_by: "admin",
  created_at: "2026-10-25T10:00:00Z",
  ...over,
})

describe("the Assigned objects tab", () => {
  it("shows each object's state with the totals and re-applies", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/prefs/columns/"))
        return { source: "none", is_forced: false, data: null }
      if (init?.method === "POST")
        return {
          assignment: assignment({ id: "a2" }),
          created: [{ kind: "tag", label: "rds" }],
          changed: [],
        }
      return page([
        assignment({}),
        assignment({
          id: "a2",
          device: null,
          virtual_machine: { id: "v1", name: "vm1" },
          state: "missing",
          missing_count: 2,
        }),
        assignment({
          id: "a3",
          device: { id: "d2", name: "rds2" },
          state: "edited",
          edited_count: 1,
        }),
      ])
    })
    mount(<AssignedObjects profileId="p2" />)
    const vm = (await screen.findByText("vm1")).closest("tr")!
    expect(within(vm).getByText("Missing")).toBeTruthy()
    expect(
      within(screen.getByText("rds2").closest("tr")!).getByText("Edited")
    ).toBeTruthy()
    expect(
      within(screen.getByText("rds1").closest("tr")!).getByText("OK")
    ).toBeTruthy()
    expect(screen.getByText("2 missing")).toBeTruthy()
    expect(screen.getByText("1 edited")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith(
      "/api/device-profile-assignments/?profile=p2"
    )
    fireEvent.click(within(vm).getByRole("button", { name: "Re-apply" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/device-profile-assignments/a2/reapply/",
        { method: "POST" }
      )
    )
  })
})

describe("the profile editor", () => {
  it("leaves the profile and its descendants out of the parents", () => {
    const all = [BASE, HR, NIGHT, OTHER]
    expect([...excludedParents(all, "p2")].sort()).toEqual(["p2", "p3"])
    expect([...excludedParents(all, "p1")].sort()).toEqual(["p1", "p2", "p3"])
    expect(excludedParents(all, undefined).size).toBe(0)
  })

  it("offers the custom fields every kind it applies to has", () => {
    const f = (key: string) => ({ key }) as never
    expect(
      applicableFields([f("a"), f("b")], [f("b"), f("c")], true, true).map(
        (d: { key: string }) => d.key
      )
    ).toEqual(["b"])
    expect(
      applicableFields([f("a")], [f("c")], false, true).map(
        (d: { key: string }) => d.key
      )
    ).toEqual(["c"])
  })

  it("has a card per section and sends them with the facts", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return HR
      if (path.startsWith("/api/device-profiles/"))
        return page([BASE, HR, NIGHT, OTHER])
      if (path.startsWith("/api/custom-fields/"))
        return page([
          {
            id: "cf1",
            key: "owner",
            label: "Owner",
            type: "text",
            applies_to: ["device", "virtualmachine"],
            required: false,
            description: "",
          },
        ])
      return page([])
    })
    const onSaved = vi.fn()
    mount(
      <DeviceProfileForm
        profile={{ ...HR, cf_values: { owner: "HR" } }}
        onSaved={onSaved}
        onCancel={() => {}}
      />
    )
    for (const title of [
      "Application groups",
      "Tags to add",
      "Custom field values",
      "Platform",
      "Runbook and notes",
    ])
      expect((await screen.findAllByText(title)).length).toBeGreaterThan(0)
    expect(await screen.findByDisplayValue("HR")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const call = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")!
    expect(call[0]).toBe("/api/device-profiles/p2/")
    const body = JSON.parse(String(call[1]!.body))
    expect(body).toMatchObject({
      name: "RDS HR",
      parent_id: "p1",
      applies_to_devices: true,
      applies_to_vms: false,
      application_group_ids: ["g1"],
      cf_values: { owner: "HR" },
    })
  })

  it("offers neither itself nor a child as its parent", async () => {
    mount(
      <DeviceProfileForm profile={HR} onSaved={() => {}} onCancel={() => {}} />
    )
    let trigger: HTMLElement | null = null
    for (
      let up: HTMLElement | null = await screen.findByText("Parent");
      up && !trigger;
      up = up.parentElement
    )
      trigger = up.querySelector<HTMLElement>("button[role=combobox]")
    fireEvent.click(trigger!)
    const list = await screen.findByRole("listbox")
    expect(within(list).getByText("Web")).toBeTruthy()
    expect(within(list).queryByText("RDS HR Night")).toBeNull()
    expect(within(list).queryByText("RDS HR")).toBeNull()
  })
})
