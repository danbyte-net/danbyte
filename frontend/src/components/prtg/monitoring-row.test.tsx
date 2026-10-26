// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgPlanEntry } from "@/lib/api"
import { mountWithRouter } from "./prtg-test-utils"
import { PrtgMonitoringRow } from "./monitoring-row"

// The Monitoring tab's PRTG row for an object PRTG has no device for: the
// Exclude chip and the "What would PRTG get?" preview.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))

const PLAN: PrtgPlanEntry[] = [
  {
    connection: { id: "c1", name: "lab" },
    prtg_sync: "inherit",
    managed: true,
    via: "policy",
    reason: "",
    linked: null,
    group: { objid: "64", path: "Local Probe / Servers", source: "policy" },
    policies: [{ id: "p1", name: "Servers" }],
    profiles: ["Std"],
    sensors: [
      {
        key: "danbyte-def-1",
        definition: "d1",
        profile: "Std",
        kind: "ping",
        kind_label: "Ping",
        name: "Ping",
        params: {},
        interval_seconds: null,
        tags: [],
        required: true,
        interface: null,
        template: "",
        present: false,
        sensor: null,
      },
    ],
    credentials: [{ kind: "snmp", name: "lab-v2c" }],
    problems: ["It has no primary address. Set one so PRTG can reach it."],
  },
]

const NO_GROUP =
  "No PRTG group chosen. Set one on the matching policy or under Register all on the connection."
const NOTHING =
  "Nothing registers this object. Add a policy that matches it, set Monitor in PRTG on the object, or turn on Register all."

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path === "/api/integrations/enabled/")
      return Promise.resolve({ prtg: true })
    if (path.startsWith("/api/prtg/plan/")) return Promise.resolve(PLAN)
    return Promise.resolve({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
  })
})
afterEach(cleanup)

describe("PrtgMonitoringRow without a PRTG device", () => {
  it("shows the Exclude chip and previews the plan", async () => {
    mountWithRouter(() => (
      <PrtgMonitoringRow
        parent={{ device: "d1" }}
        prtgSync="never"
        sensorsLink={(c) => c}
      />
    ))
    expect(await screen.findByText("No PRTG device.")).toBeTruthy()
    expect(screen.getByText("Exclude")).toBeTruthy()
    fireEvent.click(
      screen.getByRole("button", { name: "What would PRTG get?" })
    )
    expect(await screen.findByText("Local Probe / Servers")).toBeTruthy()
    expect(screen.getByText("Policy")).toBeTruthy()
    expect(screen.getByText("SNMP lab-v2c")).toBeTruthy()
    expect(screen.getByTestId("prtg-plan-sensor").textContent).toContain(
      "Planned"
    )
    expect(
      screen.getByText(
        "It has no primary address. Set one so PRTG can reach it."
      )
    ).toBeTruthy()
    expect(
      screen.getByText(
        "Planned only: nothing is written to PRTG until applied in the Review queue."
      )
    ).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/prtg/plan/?device=d1")
  })

  it("links each issue to where it is fixed, and the matching policies", async () => {
    apiMock.mockImplementation((path) => {
      if (path === "/api/integrations/enabled/")
        return Promise.resolve({ prtg: true })
      if (path.startsWith("/api/prtg/plan/"))
        return Promise.resolve([
          {
            ...PLAN[0],
            group: null,
            problems: [NO_GROUP],
            issues: [{ code: "no_group", text: NO_GROUP, policy: "p1" }],
          },
          {
            ...PLAN[0],
            connection: { id: "c2", name: "other" },
            managed: false,
            via: "",
            reason: NOTHING,
            reason_issue: { code: "no_match", text: NOTHING },
            policies: [],
            sensors: [],
            problems: [],
            issues: [],
          },
        ])
      return Promise.resolve({
        count: 0,
        next: null,
        previous: null,
        results: [],
      })
    })
    mountWithRouter(() => (
      <PrtgMonitoringRow parent={{ device: "d1" }} sensorsLink={(c) => c} />
    ))
    fireEvent.click(
      await screen.findByRole("button", { name: "What would PRTG get?" })
    )
    const [group, nothing] = await screen.findAllByTestId("prtg-issue")
    expect(group.textContent).toContain(NO_GROUP)
    const hrefs = (el: HTMLElement) =>
      Array.from(el.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs(group)).toEqual([
      "/prtg?tab=policies&edit=p1",
      "/prtg?tab=overview#registration",
    ])
    expect(nothing.textContent).toContain(NOTHING)
    expect(hrefs(nothing)).toEqual([
      "/prtg?tab=policies",
      "/devices/d1/edit",
      "/prtg?tab=overview#registration",
    ])
    // The policies that match link to their detail.
    expect(
      screen.getByRole("link", { name: "Servers" }).getAttribute("href")
    ).toBe("/prtg?tab=policies&policy=p1")
  })
})

describe("PrtgMonitoringRow for a device Danbyte created", () => {
  it("says so on the row and shows the last apply in the preview", async () => {
    const link = {
      id: "l1",
      connection: "c1",
      device: { id: "d1", name: "edge" },
      virtual_machine: null,
      objid: "2120",
      name: "edge",
      host: "10.0.0.90",
      probe_name: "Local Probe",
      group_path: "Local Probe",
      matched_by: "created",
      created_here: true,
      tagged: true,
      status_raw: 3,
      state: "up",
      sensor_counts: { total: 1, up: 1 },
      status_read_at: null,
      last_seen_at: null,
      url: "https://prtg.example.com/device.htm?id=2120",
      maintenance_paused_at: null,
      maintenance_paused_until: null,
      maintenance_events: [],
      maintenance_note: "",
    }
    apiMock.mockImplementation((path) => {
      if (path === "/api/integrations/enabled/")
        return Promise.resolve({ prtg: true })
      if (path.startsWith("/api/prtg/plan/"))
        return Promise.resolve([
          {
            ...PLAN[0],
            linked: {
              objid: "2120",
              name: "edge",
              group: "Local Probe",
              url: link.url,
              created_here: true,
            },
            last_apply: {
              at: "2026-10-26T09:00:00Z",
              kind: "create_device",
              ok: true,
              detail: "Created edge in PRTG as device 2120.",
              result: { device: "2120" },
              by: "root",
            },
          },
        ])
      if (path.startsWith("/api/prtg/links/"))
        return Promise.resolve({
          count: 1,
          next: null,
          previous: null,
          results: [link],
        })
      return Promise.resolve({
        count: 0,
        next: null,
        previous: null,
        results: [],
      })
    })
    mountWithRouter(() => (
      <PrtgMonitoringRow parent={{ device: "d1" }} sensorsLink={(c) => c} />
    ))
    expect((await screen.findAllByText("Created by Danbyte")).length).toBe(1)
    fireEvent.click(
      screen.getByRole("button", { name: "What would PRTG get?" })
    )
    expect(
      (await screen.findByTestId("prtg-last-apply")).textContent
    ).toContain("Created edge in PRTG as device 2120.")
  })
})
