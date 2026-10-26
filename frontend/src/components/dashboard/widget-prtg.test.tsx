// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import type { PrtgChannels, PrtgHistory } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { mountWithRouter, sensor } from "@/components/prtg/prtg-test-utils"
import { CATALOG_BY_ID } from "./catalog"
import { SensorAlarmsWidget, SensorWidget } from "./widget-prtg"
import type { SensorWidgetConfig } from "./widget-prtg"

// The dashboard's Sensor widget (one channel as a gauge, lookup bar, value
// or sparkline, with its settings while editing) and the Sensor alarms
// widget.

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

const SSL = sensor("2091", {
  id: "s1",
  name: "SSL Certificate",
  state: "degraded",
  status: "Warning",
})

const CHANNELS: PrtgChannels = {
  fetched_at: "2026-10-26T08:00:00Z",
  summary: {},
  rows: [
    {
      id: "2",
      name: "Days to Expiration",
      value: "781 #",
      value_raw: 781,
      unit: "#",
      kind: "number",
      state: "up",
      status: "Up",
      lookup_label: "",
      limits: {
        warn_min: null,
        warn_max: null,
        error_min: null,
        error_max: null,
      },
      lookup_states: [],
      min: 0,
      max: 800,
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

const HISTORY: PrtgHistory = {
  range: "24h",
  avg: 900,
  fetched_at: null,
  stale: false,
  channels: [
    {
      id: "2",
      name: "Days to Expiration",
      unit: "#",
      points: [
        { t: "2026-10-26T07:00:00Z", v: 782 },
        { t: "2026-10-26T07:15:00Z", v: 781 },
      ],
    },
  ],
}

type Route = (path: string, init?: RequestInit) => unknown

function serve(extra: Route = () => undefined) {
  apiMock.mockImplementation(async (path, init) => {
    const hit = extra(path, init)
    if (hit !== undefined) {
      if (hit instanceof Error) throw hit
      return hit
    }
    if (path === "/api/prtg/sensors/s1/") return SSL
    if (path.startsWith("/api/prtg/sensors/s1/channels/")) return CHANNELS
    if (path.startsWith("/api/prtg/sensors/s1/history/")) return HISTORY
    if (path.startsWith("/api/prtg/sensors/"))
      return { count: 1, next: null, previous: null, results: [SSL] }
    return { count: 0, next: null, previous: null, results: [] }
  })
}

beforeEach(() => {
  apiMock.mockReset()
  serve()
})
afterEach(cleanup)

function mount(
  config: SensorWidgetConfig,
  editing = false,
  setConfig = vi.fn()
) {
  mountWithRouter(() => (
    <TooltipProvider>
      <SensorWidget config={config} editing={editing} setConfig={setConfig} />
    </TooltipProvider>
  ))
  return setConfig
}

const BASE: SensorWidgetConfig = {
  object: "device",
  device: "d1",
  sensor: "s1",
}

describe("SensorWidget", () => {
  it("draws the primary channel as a gauge with the state pill and a link", async () => {
    mount({ ...BASE, display: "gauge" })
    const w = await screen.findByTestId("sensor-widget")
    await waitFor(() => expect(w.querySelector("[role=meter]")).toBeTruthy())
    expect(w.querySelector("[role=meter]")?.getAttribute("aria-valuenow")).toBe(
      "781"
    )
    const link = screen.getByText(/SSL Certificate/).closest("a")
    expect(link?.getAttribute("href")).toContain("/devices/d1")
    expect(link?.getAttribute("href")).toContain("tab=sensors")
    expect(link?.getAttribute("href")).toContain("sensor=s1")
    expect(w.textContent).toMatch(/degraded/i)
  })

  it("draws a chosen lookup channel as the lookup bar", async () => {
    mount({ ...BASE, channel: "3", display: "lookup" })
    const w = await screen.findByTestId("sensor-widget")
    await waitFor(() =>
      expect(w.querySelector("[data-current]")?.getAttribute("data-tone")).toBe(
        "warning"
      )
    )
  })

  it("draws the plain value", async () => {
    mount({ ...BASE, display: "value" })
    expect((await screen.findByTestId("prtg-channel-value")).textContent).toBe(
      "781 #"
    )
  })

  it("draws a sparkline over its range", async () => {
    mount({ ...BASE, display: "sparkline", range: "24h" })
    const w = await screen.findByTestId("sensor-widget")
    await waitFor(() => expect(w.querySelector("svg path")).toBeTruthy())
    expect(
      apiMock.mock.calls.some(([p]) =>
        p.startsWith("/api/prtg/sensors/s1/history/?range=24h")
      )
    ).toBe(true)
  })

  it("says No data when the sensor is gone", async () => {
    serve((p) =>
      p === "/api/prtg/sensors/s1/" ? new ApiError(404, "Not found") : undefined
    )
    mount({ ...BASE })
    expect(await screen.findByText("No data")).toBeTruthy()
  })

  it("says No access when the viewer cannot see the device", async () => {
    serve((p) =>
      p === "/api/prtg/sensors/s1/" || p === "/api/devices/d1/"
        ? new ApiError(404, "Not found")
        : undefined
    )
    mount({ ...BASE })
    expect(await screen.findByText("No access")).toBeTruthy()
  })

  it("asks for a sensor before it has one", async () => {
    mount({})
    expect(await screen.findByText("No sensor chosen.")).toBeTruthy()
  })
})

describe("SensorWidget settings", () => {
  it("lists the object's sensors and keeps only ids", async () => {
    const setConfig = mount({ ...BASE }, true)
    await screen.findByTestId("sensor-widget-settings")
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) =>
          p.startsWith("/api/prtg/sensors/?device=d1")
        )
      ).toBe(true)
    )
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Cert" },
    })
    expect(setConfig).toHaveBeenLastCalledWith({ ...BASE, title: "Cert" })
    fireEvent.click(screen.getByRole("button", { name: "VM" }))
    expect(setConfig).toHaveBeenLastCalledWith({
      ...BASE,
      object: "virtual_machine",
      device: null,
      virtual_machine: null,
      sensor: null,
      channel: "",
    })
  })

  it("offers the range only for a sparkline", async () => {
    mount({ ...BASE, display: "gauge" }, true)
    await screen.findByTestId("sensor-widget-settings")
    expect(screen.queryByRole("button", { name: "24h" })).toBeNull()
    cleanup()
    mount({ ...BASE, display: "sparkline" }, true)
    await screen.findByTestId("sensor-widget-settings")
    expect(screen.getByRole("button", { name: "24h" })).toBeTruthy()
  })

  it("puts the title override on the tile", () => {
    const w = CATALOG_BY_ID["prtg-sensor"]
    expect(w.titleOf?.({ title: " Cert " })).toBe("Cert")
    expect(w.titleOf?.({})).toBeUndefined()
    expect(w.multi).toBe(true)
  })
})

describe("SensorAlarmsWidget", () => {
  it("lists the alarms capped to its rows, with a link to the rest", async () => {
    serve((p) =>
      p.startsWith("/api/prtg/sensors/?alarms=1")
        ? { count: 12, next: null, previous: null, results: [SSL] }
        : undefined
    )
    mountWithRouter(() => (
      <TooltipProvider>
        <SensorAlarmsWidget config={{ connection: "c1", limit: 5 }} />
      </TooltipProvider>
    ))
    expect(await screen.findByText("SSL Certificate")).toBeTruthy()
    expect(
      apiMock.mock.calls.some(
        ([p]) =>
          p ===
          "/api/prtg/sensors/?alarms=1&ordering=alarms&page_size=5&connection=c1"
      )
    ).toBe(true)
    const all = screen.getByText("All 12 alarms").closest("a")
    expect(all?.getAttribute("href")).toBe("/prtg?tab=alarms")
  })

  it("says No data while the integration is off", async () => {
    serve((p) =>
      p.startsWith("/api/prtg/sensors/?alarms=1")
        ? new ApiError(404, "Not found")
        : undefined
    )
    mountWithRouter(() => <SensorAlarmsWidget />)
    expect(await screen.findByText("No data")).toBeTruthy()
  })
})
