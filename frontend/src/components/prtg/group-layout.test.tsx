// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgChange, PrtgConnection, PrtgLayoutPreview } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgGroupLayoutCard } from "./group-layout"
import { PlannedDetail, treePath } from "./changes"

// The Overview's Group layout card with its preview, and a Create group row
// in the queue.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const conn = {
  ...CONN,
  register_group_id: "1",
  register_group_path: "Local Probe",
  group_layout: "sites_roles",
  layout_regions: true,
  layout_locations: true,
  layout_root_id: "",
  layout_root_path: "",
} as PrtgConnection

const PREVIEW: PrtgLayoutPreview = {
  root: { objid: "1", path: "Local Probe", name: "Local Probe", kind: "probe" },
  layout: "sites_roles",
  rows: [
    {
      object: { kind: "device", id: "d1", name: "sw-core-1" },
      path: [
        { name: "Denmark", kind: "region", exists: true, matched_by: "tag" },
        { name: "København HQ", kind: "site", exists: false, matched_by: "" },
        { name: "Core switches", kind: "role", exists: false, matched_by: "" },
      ],
    },
    {
      object: { kind: "device", id: "d2", name: "zz-ap-1" },
      path: [],
    },
  ],
  groups: [],
  total: 600,
}

beforeEach(() => {
  apiMock.mockImplementation((path: string) => {
    if (path.includes("layout-preview")) return Promise.resolve(PREVIEW)
    if (path.startsWith("/api/prtg/groups/"))
      return Promise.resolve({
        connection: "c1",
        read_at: null,
        groups: [],
        error: "",
      })
    return Promise.resolve({})
  })
})
afterEach(() => {
  cleanup()
  apiMock.mockReset()
})

describe("PrtgGroupLayoutCard", () => {
  it("previews the tree from Danbyte's data", async () => {
    mountWithRouter(() => <PrtgGroupLayoutCard connection={conn} canManage />)
    await screen.findByText("Core switches")
    expect(screen.getByText("Denmark")).toBeTruthy()
    expect(screen.getByText("København HQ")).toBeTruthy()
    expect(screen.getAllByText("New group")).toHaveLength(2)
    expect(screen.getByText("No site")).toBeTruthy()
    expect(screen.getByText("stays in Local Probe")).toBeTruthy()
    expect(screen.getByText("First 2 of 600 devices and VMs.")).toBeTruthy()
    expect(screen.queryByText("sw-core-1")).toBeNull()
    fireEvent.click(screen.getByText("Core switches"))
    expect(screen.getByText("sw-core-1")).toBeTruthy()
    const call = apiMock.mock.calls.find(([p]) => p.includes("layout-preview"))
    expect(call?.[0]).toContain("layout=sites_roles")
    await waitFor(() => expect(screen.queryByText("Save")).toBeNull())
  })
})

describe("Create group rows", () => {
  it("say Create group with the path", () => {
    const row = {
      id: "x",
      kind: "create_group",
      kind_display: "Create group in PRTG",
      detail: {
        name: "Core switches",
        path: "Local Probe / Denmark / Core switches",
      },
    } as unknown as PrtgChange
    render(<PlannedDetail change={row} />)
    expect(screen.getByTestId("prtg-create-group").textContent).toBe(
      "Create groupLocal Probe › Denmark › Core switches"
    )
    expect(treePath("A / B")).toBe("A › B")
  })
})
