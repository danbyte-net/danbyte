// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgPolicy } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgPolicies } from "./policies"

// The /prtg Policies tab: the list says what each policy picks and where it
// puts it; the editor sends the scope's own target and the PRTG group.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const POLICY: PrtgPolicy = {
  id: "p1",
  connection: "c1",
  name: "Core switches",
  enabled: true,
  priority: 10,
  scope: "site",
  scope_display: "Site",
  region: null,
  target_site: "s1",
  location: null,
  platform: null,
  device_type: null,
  device_role: null,
  target_name: "Lab",
  match_tags: ["core"],
  match_name: "sw-*",
  match_hardware: "",
  applies_to_devices: true,
  applies_to_vms: false,
  profile: "pr1",
  profile_name: "Ping",
  group_id: "64",
  group_path: "Local Probe / Servers",
  created_at: "",
  updated_at: "",
}

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method) return Promise.resolve(POLICY)
    if (path.startsWith("/api/prtg/policies/")) return page([POLICY])
    if (path.startsWith("/api/prtg/profiles/"))
      return page([{ id: "pr1", name: "Ping", definitions: [] }])
    if (path.startsWith("/api/prtg/groups/"))
      return Promise.resolve({
        connection: "c1",
        read_at: null,
        error: "",
        groups: [
          {
            objid: "64",
            name: "Servers",
            kind: "group",
            path: "Local Probe / Servers",
            probe: "Local Probe",
            parent_id: "54",
          },
        ],
      })
    if (path.startsWith("/api/sites/")) return page([{ id: "s1", name: "Lab" }])
    if (path.startsWith("/api/tags/"))
      return page([
        { id: 1, name: "Core", slug: "core", color: "", text_color: "" },
      ])
    return page([])
  })
})
afterEach(cleanup)

describe("PrtgPolicies", () => {
  it("lists what a policy picks, its profile and its group", async () => {
    mountWithRouter(() => <PrtgPolicies connection={CONN} canManage />)
    expect(await screen.findByText("Core switches")).toBeTruthy()
    expect(screen.getByText("Lab")).toBeTruthy()
    expect(screen.getByText("Devices")).toBeTruthy()
    expect(screen.queryByText("VMs")).toBeNull()
    expect(screen.getByText("Local Probe / Servers")).toBeTruthy()
    expect(screen.getByText(/name sw-\* · tags core/)).toBeTruthy()
  })

  it("saves the scope's target and the group", async () => {
    mountWithRouter(() => <PrtgPolicies connection={CONN} canManage />)
    await screen.findByText("Core switches")
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByDisplayValue("Core switches"), {
      target: { value: "Core" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Save policy" }))
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(
        true
      )
    )
    const [path, init] = apiMock.mock.calls.find(
      ([, i]) => i?.method === "PATCH"
    )!
    expect(path).toBe("/api/prtg/policies/p1/")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Core",
      scope: "site",
      target_site: "s1",
      match_tags: ["core"],
      applies_to_vms: false,
      profile: "pr1",
      group_id: "64",
      group_path: "Local Probe / Servers",
      priority: 10,
    })
  })
})
