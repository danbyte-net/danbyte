// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CONN, mountWithRouter, sensor } from "./prtg-test-utils"
import { PrtgSensors } from "./sensors"

// The /prtg Sensors tab: every sensor with its last value and uptime, and
// "Hide paused" taking paused sensors out.

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

const ROWS = [
  sensor("2089", { name: "Lab ping", last_value: "4 msec", uptime_pct: 99.5 }),
  sensor("2100", {
    name: "HTTP paused",
    paused: true,
    state: "unknown",
    status: "Paused by User",
    status_raw: 7,
  }),
  sensor("3001", {
    name: "VM ping",
    device: null,
    virtual_machine: { id: "v1", name: "zabbix-vm" },
  }),
]

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path.startsWith("/api/prtg/sensors/")
        ? { count: ROWS.length, next: null, previous: null, results: ROWS }
        : {}
    )
  )
})
afterEach(cleanup)

describe("PrtgSensors", () => {
  it("lists every sensor with its value and uptime", async () => {
    mountWithRouter(() => <PrtgSensors connection={CONN} />)
    await screen.findByText("Lab ping")
    expect(screen.getByText("HTTP paused")).toBeTruthy()
    expect(screen.getByText("4 msec")).toBeTruthy()
    expect(screen.getByText("99.50 %")).toBeTruthy()
    // A VM's sensor links to the VM's Sensors tab.
    expect(screen.getByText("VM ping").closest("a")?.getAttribute("href")).toBe(
      "/virtual-machines/v1?tab=sensors&sensor=s3001"
    )
  })

  it("hides paused sensors when asked", async () => {
    mountWithRouter(() => <PrtgSensors connection={CONN} />)
    await screen.findByText("HTTP paused")
    fireEvent.click(screen.getByRole("switch", { name: "Hide paused" }))
    await waitFor(() => expect(screen.queryByText("HTTP paused")).toBeNull())
    expect(screen.getByText("Lab ping")).toBeTruthy()
  })
})
