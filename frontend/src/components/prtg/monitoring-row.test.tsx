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
    problems: ["It has no primary address for PRTG to reach."],
  },
]

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
      screen.getByText("It has no primary address for PRTG to reach.")
    ).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/prtg/plan/?device=d1")
  })
})
