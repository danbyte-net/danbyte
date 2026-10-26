// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgChannels, PrtgDeviceLink } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { mountWithRouter, sensor } from "./prtg-test-utils"
import { PrtgMonitoringRow } from "./monitoring-row"
import { PrtgSensorsTab, countSensors, currentLookup } from "./sensors-tab"

// The device and VM Sensors tab: the strip's counts, a card per sensor with
// PRTG's message when it is not up, the panel with gauges and lookup bars,
// and the one PRTG row on the Monitoring tab.

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
  status_raw: 3,
  state: "down",
  sensor_counts: { total: 3, up: 1, down: 1, paused: 1 },
  status_read_at: "2026-10-26T08:00:00Z",
  last_seen_at: "2026-10-26T08:00:00Z",
  url: "https://prtg.example.com/device.htm?id=2081",
} satisfies PrtgDeviceLink

const SENSORS = [
  sensor("2092", {
    name: "Ping v2",
    state: "down",
    status: "Down",
    message: "Destination unreachable",
    last_value: "",
  }),
  sensor("2089", { name: "HTTP v2", last_value: "14 msec", message: "OK" }),
  sensor("2100", {
    name: "HTTP",
    paused: true,
    state: "unknown",
    status: "Paused by User",
    message: "Paused by user",
  }),
]

const CHANNELS: PrtgChannels = {
  fetched_at: "2026-10-26T08:00:00Z",
  summary: { message: "Destination unreachable" },
  rows: [
    {
      id: "0",
      name: "Response Time",
      value: "12 msec",
      value_raw: 12,
      unit: "msec",
      kind: "number",
      state: "up",
      status: "Up",
      lookup_label: "",
      limits: {
        warn_min: null,
        warn_max: 500,
        error_min: null,
        error_max: 1000,
      },
      lookup_states: [],
      min: 0,
      max: 1000,
      primary: true,
    },
    {
      id: "3",
      name: "Root Authority Trusted",
      value: "No",
      value_raw: 1,
      unit: "",
      kind: "lookup",
      state: "degraded",
      status: "Warning",
      lookup_label: "No",
      limits: {
        warn_min: null,
        warn_max: null,
        error_min: null,
        error_max: null,
      },
      lookup_states: [
        { value: 0, to: null, label: "Yes", state: "ok" },
        { value: 1, to: null, label: "No", state: "warning" },
      ],
      min: null,
      max: null,
      primary: false,
    },
  ],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/prtg/links/"))
      return Promise.resolve({
        count: 1,
        next: null,
        previous: null,
        results: [LINK],
      })
    if (path.startsWith("/api/prtg/sensors/summary/"))
      return Promise.resolve({
        total: 3,
        down: 1,
        degraded: 0,
        up: 1,
        unknown: 0,
        paused: 1,
        acknowledged: 0,
        read_at: null,
      })
    if (path.includes("/channels/")) return Promise.resolve(CHANNELS)
    if (path.includes("/history/"))
      return Promise.resolve({
        range: "1h",
        avg: 60,
        fetched_at: null,
        stale: false,
        channels: [
          {
            id: "0",
            name: "Response Time",
            unit: "msec",
            points: [
              { t: "2026-10-26T07:00:00Z", v: 1 },
              { t: "2026-10-26T07:01:00Z", v: 3 },
            ],
          },
        ],
      })
    if (path.startsWith("/api/prtg/sensors/"))
      return Promise.resolve({
        count: SENSORS.length,
        next: null,
        previous: null,
        results: SENSORS,
      })
    return Promise.resolve({})
  })
})
afterEach(cleanup)

function mountTab(selected?: string, onSelect = vi.fn()) {
  mountWithRouter(() => (
    <TooltipProvider>
      <PrtgSensorsTab
        parent={{ device: "d1" }}
        selected={selected}
        onSelect={onSelect}
      />
    </TooltipProvider>
  ))
  return onSelect
}

describe("PrtgSensorsTab", () => {
  it("counts each state in the strip, paused apart", async () => {
    mountTab()
    const strip = await screen.findByTestId("prtg-state-strip")
    expect(strip.querySelector("[data-state=down]")?.textContent).toContain("1")
    expect(strip.querySelector("[data-state=up]")?.textContent).toContain("1")
    expect(strip.querySelector("[data-state=paused]")?.textContent).toContain(
      "1"
    )
    expect(strip.querySelector("[data-state=degraded]")).toBeNull()
    expect(countSensors(SENSORS)).toEqual({
      down: 1,
      degraded: 0,
      up: 1,
      unknown: 0,
      paused: 1,
    })
  })

  it("shows PRTG's message on a card that is not up, not on one that is", async () => {
    mountTab()
    await screen.findByText("Destination unreachable")
    const messages = screen.getAllByTestId("prtg-sensor-message")
    // The down sensor and the paused one say why; the up one stays quiet.
    expect(messages.map((m) => m.textContent)).toEqual([
      "Destination unreachable",
      "Paused by user",
    ])
    expect(screen.queryByText("OK")).toBeNull()
    expect(screen.getByText("14")).toBeTruthy()
  })

  it("clamps a long message to two lines, the whole text in the tooltip", async () => {
    const long =
      "Warning caused by lookup value 'No' in channel 'Root Authority " +
      "Trusted' (Root Authority Trusted is No) and lookup value 'Yes' in " +
      "channel 'Self-Signed' (Self-Signed is Yes)"
    SENSORS[0] = { ...SENSORS[0], message: long }
    try {
      mountTab()
      const [msg] = await screen.findAllByTestId("prtg-sensor-message")
      expect(msg.textContent).toBe(long)
      // The clamp is on the text; the padded box is its parent, so no
      // sliver of a third line shows under the ellipsis.
      expect(msg.className).toContain("line-clamp-2")
      expect(msg.parentElement?.className).toContain("py-1")
      expect(msg.className).not.toContain("py-")
      // The shared tooltip, never a browser title.
      expect(msg.closest("[title]")).toBeNull()
      fireEvent.focus(msg.parentElement!)
      const tip = await screen.findByRole("tooltip")
      expect(tip.textContent).toContain(long)
    } finally {
      SENSORS[0] = { ...SENSORS[0], message: "Destination unreachable" }
    }
  })

  it("opens the panel from a card", async () => {
    const onSelect = mountTab()
    const cards = await screen.findAllByTestId("prtg-sensor-card")
    fireEvent.click(cards[0])
    expect(onSelect).toHaveBeenCalledWith("s2092")
  })

  it("draws a gauge for a number and a state bar for a lookup", async () => {
    mountTab("s2092")
    const panel = await screen.findByTestId("prtg-sensor-panel")
    await waitFor(() =>
      expect(
        panel.querySelectorAll("[data-testid=prtg-channel-card]")
      ).toHaveLength(2)
    )
    expect(panel.querySelector("[data-kind=number] [role=meter]")).toBeTruthy()
    const lookup = panel.querySelector("[data-kind=lookup]")
    expect(
      lookup?.querySelector("[data-current]")?.getAttribute("data-tone")
    ).toBe("warning")
    expect(currentLookup(CHANNELS.rows[1])).toBe("1")
  })
})

describe("PrtgMonitoringRow", () => {
  it("shows the roll-up, the strip and a link to the Sensors tab", async () => {
    mountWithRouter(() => (
      <PrtgMonitoringRow
        parent={{ device: "d1" }}
        sensorsLink={(children) => (
          <a href="/devices/d1?tab=sensors">{children}</a>
        )}
      />
    ))
    const row = await screen.findByTestId("prtg-monitoring-row")
    await waitFor(() =>
      expect(row.querySelector("[data-testid=prtg-state-strip]")).toBeTruthy()
    )
    expect(
      screen.getByText("3 sensors").closest("a")?.getAttribute("href")
    ).toBe("/devices/d1?tab=sensors")
  })

  it("is absent when PRTG has no device for it", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve({ count: 0, next: null, previous: null, results: [] })
    )
    const { container } = mountWithRouter(() => (
      <PrtgMonitoringRow parent={{ device: "d1" }} sensorsLink={(c) => c} />
    ))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(
      container.querySelector("[data-testid=prtg-monitoring-row]")
    ).toBeNull()
  })
})
