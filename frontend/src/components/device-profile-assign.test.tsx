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
import { flexRender } from "@tanstack/react-table"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { Device, DeviceProfilePreview, VirtualMachine } from "@/lib/api"
import {
  ApplyProfileDialog,
  DeviceProfilesField,
  useHostProfilesDraft,
} from "./device-profile-assign"
import { BulkApplyProfileDialog } from "./device-profile-bulk"
import { buildDeviceColumns } from "./columns/device-columns"
import { buildVmColumns } from "./columns/vm-columns"

// Device profiles on a device or VM: the Apply dialog reads the preview
// before it writes, the forms' Profiles field writes the ordered list through
// set/, the lists carry a hidden Profiles column, and Apply profile on a
// selection answers per object or with the queued job.

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
const PICKER = page([
  { id: "p1", name: "RDS", slug: "rds", color: "#10b981", path: "RDS" },
  { id: "p2", name: "Web", slug: "web", color: "", path: "Web" },
])

beforeEach(() => {
  apiMock.mockReset()
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

/** The combobox of the field labelled ``label``. */
async function comboOf(label: string): Promise<HTMLElement> {
  for (const e of await screen.findAllByText(label)) {
    for (let up: HTMLElement | null = e; up; up = up.parentElement) {
      const b = up.querySelector<HTMLElement>("button[role=combobox]")
      if (b) return b
    }
  }
  throw new Error(`no combobox for ${label}`)
}

async function pick(label: string, option: string) {
  fireEvent.click(await comboOf(label))
  const list = await screen.findByRole("listbox")
  fireEvent.click(within(list).getByText(option))
}

function preview(
  over: Partial<DeviceProfilePreview> = {}
): DeviceProfilePreview {
  return {
    profile: { id: "p1", name: "RDS", slug: "rds" },
    object: { id: "d1", name: "rds1" },
    already_assigned: false,
    refused: "",
    sections: [
      {
        kind: "application_group",
        label: "Application groups",
        create: [{ key: "group:g1", label: "Office", from: "RDS" }],
        change: [],
        present: [
          {
            key: "group:g2",
            label: "Desk",
            from: "RDS",
            reason: "Already there.",
          },
        ],
        skip: [],
      },
      {
        kind: "custom_field",
        label: "Custom fields",
        create: [],
        change: [],
        present: [],
        skip: [
          {
            key: "cf:owner",
            label: "owner",
            from: "RDS",
            value: "HR",
            reason: "Already has a value.",
          },
        ],
      },
      {
        kind: "tag",
        label: "Tags",
        create: [],
        change: [],
        present: [],
        skip: [],
      },
    ],
    missing_permissions: [],
    ...over,
  }
}

describe("ApplyProfileDialog", () => {
  it("shows the preview, then assigns the picked profile", async () => {
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/device-profiles/?picker=1") return PICKER
      if (path === "/api/device-profiles/p1/preview/") return preview()
      if (
        path === "/api/device-profile-assignments/" &&
        init?.method === "POST"
      )
        return {
          assignment: { profile: { name: "RDS" } },
          created: [{ kind: "application_group", label: "Office" }],
        }
      return page([])
    })
    const onOpenChange = vi.fn()
    mount(
      <ApplyProfileDialog
        host={{ kind: "device", id: "d1" }}
        assignedIds={["p2"]}
        open
        onOpenChange={onOpenChange}
      />
    )
    await pick("Profile", "RDS")
    const groups = await screen.findByRole("region", {
      name: "Application groups",
    })
    expect(within(groups).getByText("Will create")).toBeTruthy()
    expect(within(groups).getByText("Office")).toBeTruthy()
    expect(within(groups).getByText("Already there")).toBeTruthy()
    const cf = screen.getByRole("region", { name: "Custom fields" })
    expect(within(cf).getByText("owner: HR")).toBeTruthy()
    expect(within(cf).getByText("Already has a value.")).toBeTruthy()
    // A section with nothing in it is left out.
    expect(screen.queryByRole("region", { name: "Tags" })).toBeNull()
    const [, init] = apiMock.mock.calls.find(
      ([p]) => p === "/api/device-profiles/p1/preview/"
    )!
    expect(JSON.parse(String(init!.body))).toEqual({ device_id: "d1" })
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const post = apiMock.mock.calls.find(
      ([p, i]) =>
        p === "/api/device-profile-assignments/" && i?.method === "POST"
    )!
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      profile_id: "p1",
      device_id: "d1",
    })
  })

  it("leaves out assigned profiles and refuses while rights are missing", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/device-profiles/?picker=1") return PICKER
      if (path === "/api/device-profiles/p1/preview/")
        return preview({
          missing_permissions: [
            {
              type: "installedsoftware",
              action: "add",
              label: "Installed software",
            },
          ],
        })
      return page([])
    })
    mount(
      <ApplyProfileDialog
        host={{ kind: "vm", id: "v1" }}
        assignedIds={["p2"]}
        open
        onOpenChange={() => {}}
      />
    )
    fireEvent.click(await comboOf("Profile"))
    const list = await screen.findByRole("listbox")
    expect(within(list).queryByText("Web")).toBeNull()
    fireEvent.click(within(list).getByText("RDS"))
    expect(await screen.findByText("Missing permissions")).toBeTruthy()
    expect(screen.getByText("add installed software")).toBeTruthy()
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Apply" }).disabled
    ).toBe(true)
  })
})

function FieldHarness({ onCommit }: { onCommit: (f: () => void) => void }) {
  const draft = useHostProfilesDraft({ kind: "vm", id: "v1" })
  onCommit(() => void draft.commit({ kind: "vm", id: "v1" }))
  return <DeviceProfilesField value={draft.ids} onChange={draft.setIds} />
}

describe("the Profiles form field", () => {
  it("starts from the object's profiles and writes the list in order", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/device-profiles/?picker=1") return PICKER
      if (path === "/api/device-profile-assignments/?virtual_machine=v1")
        return page([{ id: "a1", profile: { id: "p2", name: "Web" } }])
      return { assigned: [], unassigned: [] }
    })
    let commit = () => {}
    mount(<FieldHarness onCommit={(f) => (commit = f)} />)
    expect(await screen.findByText("Web")).toBeTruthy()
    fireEvent.click(screen.getByText("Add profile…"))
    fireEvent.click(await screen.findByRole("option", { name: /RDS/ }))
    // The chips follow the order they were added in: Web first, then RDS.
    const chips = screen
      .getAllByRole("button", { name: /^Remove / })
      .map((b) => b.getAttribute("aria-label"))
    expect(chips).toEqual(["Remove Web", "Remove RDS"])
    commit()
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/device-profile-assignments/set/",
        expect.objectContaining({ method: "POST" })
      )
    )
    const [, init] = apiMock.mock.calls.find(
      ([p]) => p === "/api/device-profile-assignments/set/"
    )!
    expect(JSON.parse(String(init!.body))).toEqual({
      virtual_machine_id: "v1",
      profile_ids: ["p2", "p1"],
    })
  })
})

describe("the Profiles column", () => {
  it("is on the device and VM lists, hidden until ticked", () => {
    for (const cols of [
      buildDeviceColumns<Device>(),
      buildVmColumns<VirtualMachine>(),
    ]) {
      const col = cols.find((c) => c.id === "device_profiles")!
      expect(col).toBeTruthy()
      expect(col.meta?.defaultHidden).toBe(true)
    }
  })

  it("shows the profiles as badges, a state where one is out of step", async () => {
    const col = buildDeviceColumns<Device>().find(
      (c) => c.id === "device_profiles"
    )!
    const row = {
      device_profiles: [
        {
          id: "p1",
          assignment_id: "a1",
          name: "RDS",
          slug: "rds",
          color: "#10b981",
          state: "ok",
        },
        {
          id: "p2",
          assignment_id: "a2",
          name: "Web",
          slug: "web",
          color: "",
          state: "missing",
        },
      ],
    } as unknown as Device
    mount(
      <div data-testid="cell">
        {flexRender(col.cell, { row: { original: row } } as never)}
      </div>
    )
    const cell = await screen.findByTestId("cell")
    expect(within(cell).getByText("RDS")).toBeTruthy()
    expect(within(cell).getByText("Web")).toBeTruthy()
    expect(within(cell).getByText("Missing")).toBeTruthy()
    expect(within(cell).queryByText("OK")).toBeNull()
  })
})

describe("Apply profile on a selection", () => {
  it("answers each object inline", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/device-profiles/?picker=1") return PICKER
      return {
        results: [
          { id: "d1", name: "rds1", outcome: "assigned" },
          { id: "d2", name: "rds2", outcome: "denied" },
        ],
        counts: { assigned: 1, denied: 1 },
      }
    })
    mount(
      <BulkApplyProfileDialog
        kind="device"
        ids={["d1", "d2"]}
        open
        onOpenChange={() => {}}
      />
    )
    await pick("Profile", "RDS")
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    expect(await screen.findByText("rds2")).toBeTruthy()
    expect(screen.getByText("Not allowed")).toBeTruthy()
    expect(screen.getByText("Applied 1")).toBeTruthy()
    const [, init] = apiMock.mock.calls.find(
      ([p]) => p === "/api/device-profile-assignments/bulk/"
    )!
    expect(JSON.parse(String(init!.body))).toEqual({
      profile_id: "p1",
      action: "assign",
      device_ids: ["d1", "d2"],
    })
  })

  it("links the job when it runs in the background", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path === "/api/device-profiles/?picker=1") return PICKER
      return { job_id: "job-9", count: 30 }
    })
    const ids = Array.from({ length: 30 }, (_, i) => `v${i}`)
    mount(
      <BulkApplyProfileDialog
        kind="vm"
        ids={ids}
        open
        onOpenChange={() => {}}
      />
    )
    await pick("Profile", "RDS")
    fireEvent.click(screen.getByRole("button", { name: "Apply" }))
    const link = await screen.findByRole("link", { name: "Open the job" })
    expect(link.getAttribute("href")).toBe("/jobs/job-9")
    expect(screen.getByText(/Queued for 30 VMs/)).toBeTruthy()
  })
})
