// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgPlanEntry } from "@/lib/api"
import { mountWithRouter } from "./prtg-test-utils"
import { PrtgMonitoringRow } from "./monitoring-row"

// The Monitoring tab's PRTG row: the Exclude chip, and the details its
// chevron opens in place - in PRTG, managed by Danbyte, what registers it
// and what is planned - with the Register action.

const { apiMock, canDo } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDo: vi.fn(() => true),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo, humanIds: false }),
}))

const NOTHING =
  "Nothing registers this object. Add a policy that matches it, set Monitor in PRTG on the object, or turn on Register all."
const EXCLUDED = "Exclude from PRTG is set on this object."

const BASE: PrtgPlanEntry = {
  connection: { id: "c1", name: "lab" },
  prtg_sync: "inherit",
  managed: false,
  registers: false,
  registration: { mode: "none", policies: [], group: null },
  planned: {
    create_device: false,
    sensors: [],
    move: null,
    remove: [],
    reasons: [],
    queued: 0,
  },
  via: "",
  reason: "",
  reason_issue: null,
  linked: null,
  group: null,
  policies: [],
  profiles: [],
  sensors: [],
  credentials: [],
  problems: [],
  issues: [],
}

/** Linked by address, made outside Danbyte, nothing registers it. */
const LINKED: PrtgPlanEntry = {
  ...BASE,
  linked: {
    objid: "2095",
    name: "gw 10.0.0.0",
    group: "Linux",
    host: "10.0.0.1",
    url: "https://prtg.example.com/device.htm?id=2095",
    matched_by: "address",
    created_here: false,
    created_at: "2026-10-01T08:00:00Z",
  },
}

const POLICY: PrtgPlanEntry = {
  ...BASE,
  registers: true,
  via: "policy",
  registration: {
    mode: "policies",
    policies: [{ id: "p1", name: "Core switches" }],
    group: { objid: "64", path: "Local Probe / Servers", source: "policy" },
  },
  planned: {
    ...BASE.planned,
    create_device: true,
    sensors: [
      {
        key: "danbyte-def-1",
        name: "Ping",
        kind: "ping",
        kind_label: "Ping",
        interface: null,
      },
    ],
    queued: 1,
  },
  issues: [
    {
      code: "no_address",
      text: "It has no primary address. Set one so PRTG can reach it.",
    },
  ],
}

const EXCLUDED_ENTRY: PrtgPlanEntry = {
  ...BASE,
  prtg_sync: "never",
  via: "never",
  registration: { mode: "never", policies: [], group: null },
  planned: {
    ...BASE.planned,
    reasons: [{ code: "excluded", text: EXCLUDED }],
  },
}

function serve(plan: PrtgPlanEntry[]) {
  apiMock.mockImplementation((path) => {
    if (path === "/api/integrations/enabled/")
      return Promise.resolve({ prtg: true })
    if (path.startsWith("/api/prtg/plan/")) return Promise.resolve(plan)
    if (path.startsWith("/api/devices/") || path.includes("/plan-now/"))
      return Promise.resolve({})
    return Promise.resolve({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
  })
}

function mount(prtgSync?: "never") {
  mountWithRouter(() => (
    <PrtgMonitoringRow
      parent={{ device: "d1" }}
      prtgSync={prtgSync}
      sensorsLink={(c) => c}
    />
  ))
}

async function expand() {
  fireEvent.click(await screen.findByRole("button", { name: "Details" }))
  return screen.findByTestId("prtg-details")
}

function row(label: string): string {
  const cell = screen
    .getAllByText(label)
    .find((el) => el.closest("tr"))
    ?.closest("tr")
  return cell?.textContent ?? ""
}

beforeEach(() => {
  apiMock.mockReset()
  canDo.mockReset()
  canDo.mockReturnValue(true)
  try {
    window.localStorage.clear()
  } catch {
    // no storage in this environment
  }
  serve([BASE])
})
afterEach(cleanup)

describe("PrtgMonitoringRow", () => {
  it("has no plan dialog and keeps the details collapsed until asked", async () => {
    mount("never")
    expect(await screen.findByText("No PRTG device.")).toBeTruthy()
    expect(screen.getByText("Exclude")).toBeTruthy()
    expect(screen.queryByText("What would PRTG get?")).toBeNull()
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByTestId("prtg-details")).toBeNull()
    expect(apiMock).not.toHaveBeenCalledWith("/api/prtg/plan/?device=d1")
  })

  it("shows a linked device made outside Danbyte as in PRTG, not managed", async () => {
    serve([LINKED])
    mount()
    await expand()
    expect(await screen.findByText("gw 10.0.0.0")).toBeTruthy()
    expect(row("In PRTG")).toContain("Yes")
    expect(row("In PRTG")).toContain("matched by address")
    expect(
      screen.getByText("gw 10.0.0.0").closest("a")?.getAttribute("href")
    ).toBe("https://prtg.example.com/device.htm?id=2095")
    expect(row("Managed by Danbyte")).toContain("No")
    expect(row("Registration")).toContain("Nothing registers it")
    expect(row("Planned")).toContain("Nothing planned")
    expect(screen.queryByText(NOTHING)).toBeNull()
    // Already in PRTG: nothing to register.
    expect(
      screen.queryByRole("button", { name: "Register in PRTG" })
    ).toBeNull()
    expect(screen.queryByText("Open review queue")).toBeNull()
  })

  it("shows an unlinked device's policy and its planned sensors", async () => {
    serve([POLICY])
    mount()
    await expand()
    expect(await screen.findByText("Core switches")).toBeTruthy()
    expect(row("In PRTG")).toContain("No")
    expect(
      screen.getByRole("link", { name: "Core switches" }).getAttribute("href")
    ).toBe("/prtg?tab=policies&policy=p1")
    expect(row("Planned")).toContain("Create the PRTG device")
    expect(row("Planned")).toContain("Local Probe / Servers")
    expect(screen.getByTestId("prtg-plan-sensor").textContent).toContain("Ping")
    expect(
      screen.getByText(
        "It has no primary address. Set one so PRTG can reach it."
      )
    ).toBeTruthy()
    expect(
      screen
        .getByRole("link", { name: "Open review queue" })
        .getAttribute("href")
    ).toBe("/prtg?tab=review&object=d1")
    expect(
      screen.getByRole("button", { name: "Register in PRTG" })
    ).toBeTruthy()
  })

  it("shows an excluded object with its reason and no Register", async () => {
    serve([EXCLUDED_ENTRY])
    mount("never")
    await expand()
    expect(await screen.findByText(EXCLUDED)).toBeTruthy()
    expect(row("Registration")).toContain("Excluded")
    expect(row("Planned")).toContain("Nothing planned")
    expect(
      screen.queryByRole("button", { name: "Register in PRTG" })
    ).toBeNull()
  })

  it("registers through the object's API, which plans it", async () => {
    serve([{ ...BASE, planned: { ...BASE.planned, reasons: [] } }])
    mount()
    await expand()
    fireEvent.click(
      await screen.findByRole("button", { name: "Register in PRTG" })
    )
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/devices/d1/",
        expect.objectContaining({ method: "PATCH" })
      )
    )
    // The save plans it; no full planning pass from here.
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/prtg/connections/c1/plan-now/",
      expect.anything()
    )
    const patch = apiMock.mock.calls.find(([p]) => p === "/api/devices/d1/")
    expect(patch?.[1]).toEqual({
      method: "PATCH",
      body: JSON.stringify({ prtg_sync: "always" }),
    })
  })

  it("hides Register from someone who may not change the device", async () => {
    canDo.mockImplementation(((type: string) => type !== "device") as never)
    mount()
    await expand()
    expect(await screen.findByText("Nothing registers it")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Register in PRTG" })
    ).toBeNull()
  })

  it("remembers the open details in this browser", async () => {
    window.localStorage.setItem("danbyte.prtg.monitoring-details", "1")
    mount()
    expect(await screen.findByTestId("prtg-details")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Details" }))
    expect(window.localStorage.getItem("danbyte.prtg.monitoring-details")).toBe(
      "0"
    )
    expect(screen.queryByTestId("prtg-details")).toBeNull()
  })
})

describe("PrtgMonitoringRow for a device Danbyte created", () => {
  const LINK = {
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
  const CREATED: PrtgPlanEntry = {
    ...BASE,
    managed: true,
    linked: {
      objid: "2120",
      name: "edge",
      group: "Local Probe",
      host: "10.0.0.90",
      url: LINK.url,
      matched_by: "created",
      created_here: true,
      created_at: "2026-10-26T08:00:00Z",
    },
    last_apply: {
      at: "2026-10-26T09:00:00Z",
      kind: "create_device",
      ok: true,
      detail: "Created edge in PRTG as device 2120.",
      result: { device: "2120" },
      by: "root",
    },
  }

  function serveWithLink(plan: PrtgPlanEntry[]) {
    apiMock.mockImplementation((path) => {
      if (path === "/api/integrations/enabled/")
        return Promise.resolve({ prtg: true })
      if (path.startsWith("/api/prtg/plan/")) return Promise.resolve(plan)
      if (path.startsWith("/api/prtg/links/"))
        return Promise.resolve({
          count: 1,
          next: null,
          previous: null,
          results: [LINK],
        })
      return Promise.resolve({
        count: 0,
        next: null,
        previous: null,
        results: [],
      })
    })
  }

  it("says so on the row and in the Managed line with the last apply", async () => {
    serveWithLink([CREATED])
    mount()
    expect((await screen.findAllByText("Created by Danbyte")).length).toBe(1)
    await expand()
    await screen.findByTestId("prtg-last-apply")
    const managed = row("Managed by Danbyte")
    expect(managed).toMatch(/Yes, created on \S/)
    expect(managed).toContain("last apply")
    expect(managed).toContain("Applied")
    // A successful apply needs no detail line.
    expect(managed).not.toContain("Created edge in PRTG")
  })

  it("shows a failed create attempt before there is a link", async () => {
    serve([
      {
        ...BASE,
        registers: true,
        last_apply: {
          at: "2026-10-26T09:00:00Z",
          kind: "create_device",
          ok: false,
          detail: "PRTG refused the device: group 64 is gone.",
          result: {},
          by: "root",
        },
      },
    ])
    mount()
    await expand()
    await screen.findByTestId("prtg-last-apply")
    const managed = row("Managed by Danbyte")
    expect(managed).toContain("No")
    expect(managed).toContain("Failed")
    expect(managed).toContain("PRTG refused the device: group 64 is gone.")
  })
})
