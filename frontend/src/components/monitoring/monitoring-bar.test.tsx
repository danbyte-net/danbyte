// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type {
  BulkStatusEntry,
  PrtgDeviceLink,
  ZabbixHostStatus,
} from "@/lib/api"
import { mountWithRouter, sensor } from "@/components/prtg/prtg-test-utils"
import {
  MonitoringBar,
  MonitoringHeaderBadge,
  matchesState,
  worstOf,
} from "./monitoring-bar"

// The monitoring bar on a device's and a VM's Overview and the pill in their
// headers: one row per source, worst wins, the list behind every pill and
// count in the shared tooltip, and each row opening its tab.

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

const CHECKS: BulkStatusEntry = {
  status: "degraded",
  counts: { degraded: 1, up: 2 },
  monitored_ips: 2,
  items: [
    {
      id: "c1",
      name: "https",
      kind: "http",
      ip_id: "ip1",
      address: "10.0.0.41",
      status: "degraded",
      since: "2026-10-26T08:00:00Z",
    },
    {
      id: "c2",
      name: "ping",
      kind: "icmp",
      ip_id: "ip1",
      address: "10.0.0.41",
      status: "up",
      since: null,
    },
    {
      id: "c3",
      name: "ping",
      kind: "icmp",
      ip_id: "ip2",
      address: "10.0.0.42",
      status: "up",
      since: null,
    },
  ],
}

const ZABBIX: ZabbixHostStatus = {
  connection: {
    id: "z1",
    name: "lab",
    url: "https://zabbix.example.com",
    read_host_status: true,
  },
  host: { hostid: "10501", name: "db-dev01" },
  link: { matched_by: "address", created_here: false },
  status: {
    problems: [
      {
        name: "High CPU utilization",
        severity: "4",
        since: "2026-10-26T07:00:00Z",
        eventid: "e1",
      },
    ],
    problem_count: 1,
    worst_severity: "4",
    worst_status: "down",
    availability: { snmp: { state: "down", error: "Timeout on 1.3.6.1" } },
    maintenance: false,
    disabled: false,
    polled_at: "2026-10-26T08:00:00Z",
  },
}

const LINK = {
  id: "l1",
  connection: "c1",
  device: { id: "d1", name: "db-dev01" },
  virtual_machine: null,
  objid: "2081",
  name: "db-dev01",
  host: "10.0.0.41",
  probe_name: "Local Probe",
  group_path: "Lab",
  matched_by: "address",
  created_here: false,
  tagged: false,
  status_raw: 4,
  state: "degraded",
  sensor_counts: { total: 2, up: 1, degraded: 1 },
  status_read_at: "2026-10-26T08:00:00Z",
  last_seen_at: "2026-10-26T08:00:00Z",
  url: "https://prtg.example.com/device.htm?id=2081",
  maintenance_paused_at: null,
  maintenance_paused_until: null,
  maintenance_events: [],
  maintenance_note: "",
} satisfies PrtgDeviceLink

const SENSORS = [
  sensor("1", {
    name: "Disk Free",
    state: "degraded",
    status: "Warning",
    message: "Below 10 %",
  }),
  sensor("2", { name: "Ping" }),
]

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

function answer({
  checks = CHECKS,
  zabbix = [ZABBIX],
  links = [LINK],
  id = "d1",
}: {
  checks?: BulkStatusEntry | null
  zabbix?: ZabbixHostStatus[]
  links?: PrtgDeviceLink[]
  id?: string
} = {}) {
  apiMock.mockImplementation((path) => {
    if (path === "/api/monitoring/status/")
      return Promise.resolve({ statuses: checks ? { [id]: checks } : {} })
    if (path.startsWith("/api/zabbix/host-status/"))
      return Promise.resolve(zabbix)
    if (path.startsWith("/api/prtg/links/")) return page(links)
    if (path.startsWith("/api/prtg/sensors/")) return page(SENSORS)
    if (path.startsWith("/api/monitoring/notifications/watch-state/"))
      return Promise.resolve({ watching: false, can_watch: true })
    return Promise.resolve({})
  })
}

beforeEach(() => {
  apiMock.mockReset()
  answer()
})
afterEach(cleanup)

const rows = () =>
  screen
    .getAllByTestId("monitoring-source")
    .map((r) => r.getAttribute("data-source"))

describe("MonitoringBar", () => {
  it("draws one row per source, worst wins on the overall pill", async () => {
    mountWithRouter(() => (
      <MonitoringBar target={{ device: "d1" }} notify={{ device: "d1" }} />
    ))
    await waitFor(() => expect(rows()).toEqual(["checks", "zabbix", "prtg"]))
    expect(screen.getByTestId("monitoring-overall").textContent).toBe("Down")
    // One request for the checks, with their detail.
    const bulk = apiMock.mock.calls.filter(
      ([p]) => p === "/api/monitoring/status/"
    )
    expect(bulk).toHaveLength(1)
    expect(JSON.parse(String(bulk[0][1]?.body))).toEqual({
      devices: ["d1"],
      detail: true,
    })
    const checks = screen.getAllByTestId("monitoring-source")[0]
    expect(checks.textContent).toContain("1 degraded")
    expect(checks.textContent).toContain("2 up")
    // No raw address as a pill on the bar.
    expect(checks.textContent).not.toContain("10.0.0.41")
    expect(
      await screen.findByRole("button", { name: /Notify me/ })
    ).toBeTruthy()
  })

  it("leaves out the sources the object does not have", async () => {
    answer({ zabbix: [], links: [] })
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(rows()).toEqual(["checks"]))
    // One source: the overall pill is the only state pill.
    expect(screen.getByTestId("monitoring-overall").textContent).toBe(
      "Degraded"
    )
    expect(screen.getAllByText("Degraded")).toHaveLength(1)
  })

  it("renders nothing when nothing monitors the object", async () => {
    answer({ checks: null, zabbix: [], links: [] })
    const { container } = mountWithRouter(() => (
      <MonitoringBar target={{ device: "d1" }} />
    ))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.querySelector("[data-testid=monitoring-bar]")).toBeNull()
  })

  it("opens each source's place on the page", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    const [checks, zabbix, prtg] = screen.getAllByTestId("monitoring-source")
    const href = (row: HTMLElement, text: string) =>
      Array.from(row.querySelectorAll("a"))
        .find((a) => a.textContent === text)
        ?.getAttribute("href")
    expect(href(checks, "Checks")).toBe(
      "/devices/d1?tab=monitoring&state=problem"
    )
    expect(href(checks, "1 degraded")).toBe(
      "/devices/d1?tab=monitoring&state=degraded"
    )
    expect(href(zabbix, "Zabbix")).toBe("/devices/d1?tab=monitoring#zabbix")
    expect(href(prtg, "PRTG")).toBe("/devices/d1?tab=sensors&state=problem")
    expect(href(prtg, "1 up")).toBe("/devices/d1?tab=sensors&state=up")
    // The object over there, in a new tab.
    expect(href(prtg, "db-dev01")).toBe(LINK.url)
    expect(href(zabbix, "db-dev01")).toContain("hostids%5B%5D=10501")
  })

  it("lists what is behind a count in the shared tooltip", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    const checks = await waitFor(
      () => screen.getAllByTestId("monitoring-source")[0]
    )
    const degraded = checks.querySelector("[data-state=degraded]")!
    expect(degraded.closest("[title]")).toBeNull()
    fireEvent.focus(degraded.closest("a")!)
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toContain("https")
    expect(tip.textContent).toContain("10.0.0.41")
    expect(tip.textContent).not.toContain("ping")
  })

  it("shows Zabbix's triggers and PRTG's sensor messages", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    const zabbix = screen.getAllByTestId("monitoring-source")[1]
    expect(zabbix.textContent).toContain("1 problem")
    expect(zabbix.textContent).toContain("SNMP unreachable")
    fireEvent.focus(
      zabbix.querySelector("[data-state=problems]")!.closest("a")!
    )
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "High CPU utilization"
    )
    cleanup()
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(rows()).toHaveLength(3))
    const prtg2 = screen.getAllByTestId("monitoring-source")[2]
    await waitFor(() =>
      expect(prtg2.querySelector("[data-state=degraded]")).toBeTruthy()
    )
    fireEvent.focus(prtg2.querySelector("[data-state=degraded]")!.closest("a")!)
    const tip = await screen.findByRole("tooltip")
    expect(tip.textContent).toContain("Disk Free")
    expect(tip.textContent).toContain("Below 10 %")
  })

  it("caps a tooltip at ten with +N more", async () => {
    const many = Array.from({ length: 14 }, (_, i) => ({
      id: `c${i}`,
      name: `check ${i}`,
      kind: "tcp",
      ip_id: "ip1",
      address: "10.0.0.41",
      status: "down" as const,
      since: null,
    }))
    answer({
      checks: { status: "down", counts: { down: 14 }, items: many },
      zabbix: [],
      links: [],
    })
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    const count = await waitFor(() => {
      const el = document.querySelector("[data-state=down]")
      expect(el).toBeTruthy()
      return el!
    })
    fireEvent.focus(count.closest("a")!)
    const tip = await screen.findByRole("tooltip")
    expect(tip.querySelectorAll("li")).toHaveLength(10)
    expect(tip.textContent).toContain("+4 more")
  })

  it("is the same bar on a VM, without Zabbix", async () => {
    answer({ id: "vm1" })
    mountWithRouter(() => <MonitoringBar target={{ virtual_machine: "vm1" }} />)
    await waitFor(() => expect(rows()).toEqual(["checks", "prtg"]))
    const bulk = apiMock.mock.calls.find(
      ([p]) => p === "/api/monitoring/status/"
    )!
    expect(JSON.parse(String(bulk[1]?.body))).toEqual({
      vms: ["vm1"],
      detail: true,
    })
    expect(apiMock.mock.calls.some(([p]) => p.startsWith("/api/zabbix/"))).toBe(
      false
    )
    const checks = screen.getAllByTestId("monitoring-source")[0]
    expect(
      Array.from(checks.querySelectorAll("a"))
        .find((a) => a.textContent === "Checks")
        ?.getAttribute("href")
    ).toBe("/virtual-machines/vm1?tab=monitoring&state=problem")
  })
})

describe("MonitoringHeaderBadge", () => {
  it.each([
    [{ device: "d1" }, "d1", "Down"],
    [{ virtual_machine: "vm1" }, "vm1", "Degraded"],
  ] as const)(
    "shows the overall pill with the shared tooltip (%o)",
    async (target, id, label) => {
      answer({ id })
      mountWithRouter(() => <MonitoringHeaderBadge target={target} />)
      const badge = await screen.findByTestId("monitoring-header-badge")
      await waitFor(() => expect(badge.textContent).toBe(label))
      expect(badge.closest("[title]")).toBeNull()
      fireEvent.focus(badge)
      const tip = await screen.findByRole("tooltip")
      expect(tip.textContent).toContain("Checks")
      expect(tip.textContent).toContain("PRTG")
      // The header never walks every sensor.
      expect(
        apiMock.mock.calls.some(([p]) => p.startsWith("/api/prtg/sensors/"))
      ).toBe(false)
    }
  )

  it("renders nothing for an unmonitored object", async () => {
    answer({ checks: null, zabbix: [], links: [] })
    const { container } = mountWithRouter(() => (
      <MonitoringHeaderBadge target={{ device: "d1" }} />
    ))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })
})

describe("helpers", () => {
  it("worst wins", () => {
    expect(worstOf(["up", "degraded", null, "unknown"])).toBe("degraded")
    expect(worstOf(["up", "stale", "down"])).toBe("down")
    expect(worstOf([null, undefined])).toBeNull()
  })

  it("matches the bar's filter", () => {
    expect(matchesState(undefined, "up")).toBe(true)
    expect(matchesState("problem", "up")).toBe(false)
    expect(matchesState("problem", "unknown")).toBe(true)
    expect(matchesState("problem", "paused")).toBe(false)
    expect(matchesState("degraded", null, { up: 2, degraded: 1 })).toBe(true)
    expect(matchesState("problem", null, { up: 2 })).toBe(false)
  })
})
