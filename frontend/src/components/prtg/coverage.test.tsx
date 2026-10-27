// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgCoverage, PrtgPlanEntry } from "@/lib/api"
import { mountWithRouter } from "./prtg-test-utils"
import { PrtgCoverageStrips } from "./coverage"

// The Coverage strip on a device's Sensors tab: the policies, "n of m
// sensors", one line when complete, a row per wanted sensor otherwise, and
// the sensors no policy wants.

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

const POLICY = { id: "p1", name: "Core switches" }

function wanted(
  key: string,
  patch: Partial<PrtgCoverage["wanted"][number]> = {}
): PrtgCoverage["wanted"][number] {
  return {
    key,
    definition: `d-${key}`,
    profile: { id: "pr1", name: "Std" },
    policy: POLICY,
    name: key,
    kind: "ping",
    kind_label: "Ping",
    required: true,
    interface: null,
    status: "present",
    ...patch,
  }
}

function entry(coverage: PrtgCoverage): PrtgPlanEntry {
  return {
    connection: { id: "c1", name: "lab" },
    linked: { objid: "2081", name: "db-dev01", group: "Lab", url: "" },
    registration: { mode: "policies", policies: [POLICY], group: null },
    coverage,
  } as unknown as PrtgPlanEntry
}

function mount(coverage: PrtgCoverage) {
  apiMock.mockImplementation((path) =>
    path.startsWith("/api/prtg/plan/")
      ? Promise.resolve([entry(coverage)])
      : Promise.resolve({ ok: true, detail: "Added." })
  )
  return mountWithRouter(() => (
    <PrtgCoverageStrips object={{ kind: "device", id: "d1" }} />
  ))
}

const BASE = {
  policies: [{ ...POLICY, profile: { id: "pr1", name: "Std" } }],
  group: { objid: "1", path: "Local Probe", source: "policy" },
  extra: [],
}

beforeEach(() => {
  apiMock.mockReset()
  window.localStorage.clear()
})
afterEach(cleanup)

describe("PrtgCoverageStrips", () => {
  it("is one line when every sensor is in PRTG", async () => {
    mount({ ...BASE, present: 2, wanted: [wanted("Ping"), wanted("Uptime")] })
    expect(
      (await screen.findByTestId("prtg-coverage-summary")).textContent
    ).toBe("2 of 2 sensors")
    expect(
      screen.getByText("Core switches").closest("a")?.getAttribute("href")
    ).toBe("/prtg?tab=policies&policy=p1")
    expect(screen.queryAllByTestId("prtg-coverage-row")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: /Coverage/ }))
    expect(screen.getAllByTestId("prtg-coverage-row")).toHaveLength(2)
    expect(window.localStorage.getItem("danbyte.prtg.coverage.complete")).toBe(
      "1"
    )
  })

  it("opens with each missing sensor's state, reason and action", async () => {
    mount({
      ...BASE,
      present: 1,
      wanted: [
        wanted("Ping", { sensor_id: "s1", sensor_objid: "2092" }),
        wanted("Uptime", { status: "planned", change_id: "ch1" }),
        wanted("CPU", {
          status: "failed",
          change_id: "ch2",
          reason: "PRTG said no.",
        }),
        wanted("Traffic", {
          status: "waiting",
          change_id: "ch3",
          reason: "No SNMP profile applies to db-dev01.",
          issue: {
            code: "no_snmp",
            text: "No SNMP profile applies to db-dev01.",
            object: { kind: "device", id: "d1" },
          },
        }),
      ],
      extra: [
        {
          sensor_id: "s9",
          objid: "2100",
          name: "HTTP",
          kind_label: "HTTP",
          origin: "prtg",
        },
      ],
    })
    expect(
      (await screen.findByTestId("prtg-coverage-summary")).textContent
    ).toBe("1 of 4 sensors · 1 not from a policy")
    expect(screen.getAllByTestId("prtg-coverage-row")).toHaveLength(4)
    expect(screen.getByText("Planned")).toBeTruthy()
    expect(screen.getByText("PRTG said no.")).toBeTruthy()
    expect(screen.getByText("Access").closest("a")?.getAttribute("href")).toBe(
      "/devices/d1?tab=access"
    )
    expect(screen.getByText("Made in PRTG")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/prtg/changes/ch2/apply/", {
        method: "POST",
      })
    )
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy()
  })

  it("is absent before PRTG has the device", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve([
        {
          ...entry({ ...BASE, present: 0, wanted: [wanted("Ping")] }),
          linked: null,
        },
      ])
    )
    const { container } = mountWithRouter(() => (
      <PrtgCoverageStrips object={{ kind: "device", id: "d1" }} />
    ))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.querySelector("[data-testid=prtg-coverage]")).toBeNull()
  })
})
