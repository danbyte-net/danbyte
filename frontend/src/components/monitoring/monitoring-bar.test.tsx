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

// The monitoring card on a device's and a VM's Overview and the pill in
// their headers: the problems first, worst first, each opening where it
// lives; a bar per source; one line when all is clear; one pill per card.

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
      error: "connect timeout",
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

const UP_CHECKS: BulkStatusEntry = {
  status: "up",
  counts: { up: 3 },
  items: CHECKS.items!.map((i) => ({ ...i, status: "up" as const })),
}
const UP_ZABBIX: ZabbixHostStatus = {
  ...ZABBIX,
  status: {
    ...ZABBIX.status,
    problems: [],
    problem_count: 0,

    worst_status: "up",
    availability: { snmp: { state: "up", error: "" } },
  },
}
const UP_LINK: PrtgDeviceLink = {
  ...LINK,
  state: "up",
  sensor_counts: { total: 1, up: 1 },
}

const card = () => screen.getByTestId("monitoring-bar")
const problems = () => screen.queryAllByTestId("monitoring-problem")
const sources = () =>
  screen
    .getAllByTestId("monitoring-source")
    .map((r) => r.getAttribute("data-source"))
/** Every pill on the card: a status pill or a Badge. */
const pills = () =>
  card().querySelectorAll("[data-check-status], [data-slot=badge]")

describe("MonitoringBar", () => {
  it("leads with the problems, worst first, across the sources", async () => {
    mountWithRouter(() => (
      <MonitoringBar target={{ device: "d1" }} notify={{ device: "d1" }} />
    ))
    await waitFor(() => expect(problems()).toHaveLength(3))
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
    const [cpu, snmp, https] = problems()
    expect(cpu.dataset.source).toBe("zabbix")
    expect(cpu.dataset.state).toBe("down")
    // A trigger reads as the host, with the trigger as its message.
    expect(cpu.textContent).toContain("db-dev01")
    expect(cpu.textContent).toContain("High CPU utilization")
    expect(cpu.textContent).toContain("Zabbix")
    expect(snmp.textContent).toContain("SNMP unreachable")
    expect(snmp.textContent).toContain("Timeout on 1.3.6.1")
    expect(https.dataset.source).toBe("checks")
    expect(https.textContent).toContain("Degraded")
    expect(https.textContent).toContain("10.0.0.41")
    expect(https.textContent).toContain("Danbyte check")
    expect(https.textContent).toMatch(/degraded \d+[smhd]/)
    expect(https.textContent).toContain("connect timeout")
    // Four in all: the fourth is behind View all.
    const all = screen.getByTestId("monitoring-view-all")
    expect(all.textContent).toBe("View all 4")
    expect(all.getAttribute("href")).toBe(
      "/devices/d1?tab=monitoring&state=problem"
    )
    expect(card().textContent).toMatch(/since \d+[smhd]/)
    expect(
      await screen.findByRole("button", { name: /Notify me/ })
    ).toBeTruthy()
  })

  it("says the state as a pill once, in the header", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(problems()).toHaveLength(3))
    await waitFor(() =>
      expect(
        document.querySelector("[data-source=prtg] a[data-state=degraded]")
      ).toBeTruthy()
    )
    expect(pills()).toHaveLength(1)
    expect(screen.getByTestId("monitoring-overall").contains(pills()[0])).toBe(
      true
    )
  })

  it("opens each problem where it lives", async () => {
    answer({ zabbix: [] })
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() =>
      expect(problems().map((p) => p.dataset.source)).toEqual([
        "checks",
        "prtg",
      ])
    )
    const [https, disk] = problems()
    expect(https.getAttribute("href")).toBe(
      "/devices/d1?tab=monitoring&state=degraded"
    )
    // The sensor's panel, opened on the Sensors tab.
    expect(disk.getAttribute("href")).toBe("/devices/d1?tab=sensors&sensor=s1")
    expect(disk.textContent).toContain("Below 10 %")
    // Two problems, both shown: no View all.
    expect(screen.queryByTestId("monitoring-view-all")).toBeNull()
    cleanup()
    answer()
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(problems()).toHaveLength(3))
    expect(problems()[0].getAttribute("href")).toBe(
      "/devices/d1?tab=monitoring#zabbix"
    )
  })

  it("puts the full message in the shared tooltip", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(problems()).toHaveLength(3))
    const msg = problems()[2].querySelector("[data-testid=problem-message]")!
    expect(msg.closest("[title]")).toBeNull()
    fireEvent.focus(msg)
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "connect timeout"
    )
  })

  it("draws a bar per source with its states in proportion", async () => {
    mountWithRouter(() => <MonitoringBar target={{ device: "d1" }} />)
    await waitFor(() => expect(sources()).toEqual(["checks", "zabbix", "prtg"]))
    const [checks, zabbix, prtg] = screen.getAllByTestId("monitoring-source")
    const widths = (row: HTMLElement) =>
      Array.from(
        row.querySelectorAll<HTMLElement>(
          "[data-testid=monitoring-source-bar] [data-state]"
        )
      ).map((x) => [x.dataset.state, Math.round(parseFloat(x.style.width))])
    expect(widths(checks)).toEqual([
      ["degraded", 33],
      ["up", 67],
    ])
    expect(checks.textContent).toContain("1 degraded · 2 up")
    expect(widths(zabbix)).toEqual([["down", 100]])
    expect(zabbix.textContent).toContain("1 problem · SNMP unreachable")
    await waitFor(() =>
      expect(widths(prtg)).toEqual([
        ["degraded", 50],
        ["up", 50],
      ])
    )
    const href = (row: HTMLElement, sel: string) =>
      row.querySelector(sel)!.closest("a")!.getAttribute("href")
    expect(href(checks, "[data-testid=monitoring-source-bar]")).toBe(
      "/devices/d1?tab=monitoring&state=problem"
    )
    expect(href(checks, "a[data-state=degraded]")).toBe(
      "/devices/d1?tab=monitoring&state=degraded"
    )
    expect(href(zabbix, "[data-testid=monitoring-source-bar]")).toBe(
      "/devices/d1?tab=monitoring#zabbix"
    )
    expect(href(prtg, "a[data-state=up]")).toBe(
      "/devices/d1?tab=sensors&state=up"
    )
  })

  it("collapses to one line when all is clear", async () => {
    answer({ checks: UP_CHECKS, zabbix: [UP_ZABBIX], links: [UP_LINK] })
    const base = apiMock.getMockImplementation()!
    apiMock.mockImplementation((path, init) =>
      path.startsWith("/api/prtg/sensors/")
        ? page([sensor("2", { name: "Ping" })])
        : base(path, init)
    )
    mountWithRouter(() => (
      <MonitoringBar target={{ device: "d1" }} notify={{ device: "d1" }} />
    ))
    const line = await screen.findByTestId("monitoring-all-clear")
    expect(line.textContent).toBe(
      "All 3 checks up · Zabbix up · PRTG 1 sensor up · "
    )
    expect(card().hasAttribute("data-compact")).toBe(true)
    expect(card().textContent).toMatch(/read \d+[smhd] ago/)
    expect(problems()).toHaveLength(0)
    expect(screen.queryByTestId("monitoring-source")).toBeNull()
    expect(pills()).toHaveLength(1)
    const link = (src: string) =>
      line.querySelector(`a[data-source=${src}]`)!.getAttribute("href")
    expect(link("checks")).toBe("/devices/d1?tab=monitoring")
    expect(link("zabbix")).toBe("/devices/d1?tab=monitoring#zabbix")
    expect(link("prtg")).toBe("/devices/d1?tab=sensors")
    expect(
      await screen.findByRole("button", { name: /Notify me/ })
    ).toBeTruthy()
  })

  it("renders in its slot: banner with problems, compact when clear", async () => {
    const both = () => (
      <>
        <div data-testid="banner">
          <MonitoringBar target={{ device: "d1" }} slot="banner" />
        </div>
        <div data-testid="compact">
          <MonitoringBar target={{ device: "d1" }} slot="compact" />
        </div>
      </>
    )
    const inside = (id: string) =>
      screen.getByTestId(id).querySelector("[data-testid=monitoring-bar]")
    mountWithRouter(both)
    await waitFor(() => expect(problems()).toHaveLength(3))
    expect(inside("banner")).toBeTruthy()
    expect(inside("compact")).toBeNull()
    cleanup()
    answer({ checks: UP_CHECKS, zabbix: [], links: [] })
    mountWithRouter(both)
    await screen.findByTestId("monitoring-all-clear")
    expect(inside("banner")).toBeNull()
    expect(inside("compact")?.hasAttribute("data-compact")).toBe(true)
  })

  it("renders nothing when nothing monitors the object", async () => {
    answer({ checks: null, zabbix: [], links: [] })
    const { container } = mountWithRouter(() => (
      <MonitoringBar target={{ device: "d1" }} />
    ))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull())
    expect(container.querySelector("[data-testid=monitoring-bar]")).toBeNull()
  })

  it("is the same card on a VM, without Zabbix", async () => {
    answer({ id: "vm1" })
    mountWithRouter(() => <MonitoringBar target={{ virtual_machine: "vm1" }} />)
    await waitFor(() => expect(sources()).toEqual(["checks", "prtg"]))
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
    await waitFor(() => expect(problems()).toHaveLength(2))
    expect(problems()[1].getAttribute("href")).toBe(
      "/virtual-machines/vm1?tab=sensors&sensor=s1"
    )
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
