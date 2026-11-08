// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgPolicy, PrtgPolicyMatch } from "@/lib/api"
import { mountWithRouter } from "./prtg-test-utils"
import { PrtgPolicyDetail } from "./policy-detail"

// A policy's detail: its facts and every device and VM it hits, with which
// policy decides the group.

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

const POLICY = {
  id: "p1",
  connection: "c1",
  name: "Core switches",
  enabled: true,
  priority: 10,
  scope: "site",
  scope_display: "Site",
  target_name: "Lab",
  match_tags: ["core"],
  match_name: "",
  match_hardware: "",
  applies_to_devices: true,
  applies_to_vms: true,
  profile: "pr1",
  profile_name: "Ping",
  group_id: "64",
  group_path: "Local Probe / Servers",
  match_count: 2,
} as PrtgPolicy

const match = (patch: Partial<PrtgPolicyMatch>): PrtgPolicyMatch => ({
  kind: "device",
  id: "d1",
  name: "sw-01",
  site: { id: "s1", name: "Lab" },
  role: { id: "r1", name: "Core" },
  platform: null,
  prtg_sync: "inherit",
  linked: false,
  link: null,
  managed: true,
  via: "policy",
  reason: "",
  group_policy: { id: "p1", name: "Core switches" },
  wins_group: true,
  policies: [{ id: "p1", name: "Core switches" }],
  ...patch,
})

const MATCHES = [
  match({
    linked: true,
    link: {
      objid: "2080",
      name: "sw-01",
      url: "https://prtg/device.htm?id=2080",
    },
  }),
  match({
    kind: "virtual_machine",
    id: "v1",
    name: "app-1",
    prtg_sync: "never",
    managed: false,
    group_policy: { id: "p0", name: "Everything" },
    wins_group: false,
  }),
  match({
    id: "d2",
    name: "sw-02",
    group_policy: { id: "p0", name: "Everything" },
    wins_group: false,
  }),
]

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/prtg/policies/p1/matches/"))
      return Promise.resolve({
        count: MATCHES.length,
        next: null,
        previous: null,
        results: MATCHES,
      })
    if (path === "/api/prtg/policies/p1/") return Promise.resolve(POLICY)
    return Promise.resolve({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
  })
})
afterEach(cleanup)

describe("PrtgPolicyDetail", () => {
  it("shows the facts and who the policy hits", async () => {
    mountWithRouter(() => <PrtgPolicyDetail policyId="p1" onClose={() => {}} />)
    const counts = await screen.findByTestId("prtg-policy-match-counts")
    expect(counts.textContent).toBe("3 · 1 linked")
    expect(screen.getByText("Site Lab")).toBeTruthy()
    expect(screen.getByText("Local Probe / Servers")).toBeTruthy()
    expect(screen.getByText("Ping")).toBeTruthy()

    const sheet = screen.getByRole("dialog")
    expect(
      within(sheet)
        .getAllByRole("link", { name: "sw-01" })[0]
        .getAttribute("href")
    ).toBe("/devices/d1")
    expect(
      within(sheet).getByRole("link", { name: "app-1" }).getAttribute("href")
    ).toBe("/virtual-machines/v1")
    expect(within(sheet).getByText("This policy")).toBeTruthy()
    expect(within(sheet).getByText("Not in plan")).toBeTruthy()
    expect(within(sheet).getByText("Exclude from PRTG")).toBeTruthy()
    expect(
      within(sheet)
        .getAllByRole("link", { name: "Everything" })[0]
        .getAttribute("href")
    ).toBe("/prtg?tab=policies&policy=p0")
    expect(apiMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/api\/prtg\/policies\/p1\/matches\//)
    )
  })
})
