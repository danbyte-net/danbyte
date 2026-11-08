// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CONN, mountWithRouter, sensor } from "./prtg-test-utils"
import { PrtgAlarms } from "./alarms"

// The /prtg Alarms tab: the server's worst-and-newest order is kept, PRTG's
// message shows on the row, and an acknowledged sensor says so.

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
  sensor("2092", {
    name: "Ping down",
    state: "down",
    status: "Down (Acknowledged)",
    status_raw: 13,
    acknowledged: true,
    message: "Destination unreachable",
    last_down_at: "2026-10-26T07:59:00Z",
  }),
  sensor("2091", {
    name: "SSL certificate",
    state: "degraded",
    status: "Warning",
    status_raw: 4,
    message: "Root Authority Trusted is No",
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

describe("PrtgAlarms", () => {
  it("asks for the alarms worst first and keeps that order", async () => {
    mountWithRouter(() => <PrtgAlarms connection={CONN} />)
    await screen.findByText("Ping down")
    const path = apiMock.mock.calls
      .map(([p]) => p)
      .find((p) => p.startsWith("/api/prtg/sensors/"))
    expect(path).toContain("connection=c1")
    expect(path).toContain("alarms=1")
    expect(path).toContain("ordering=alarms")
    const names = screen
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => t === "Ping down" || t === "SSL certificate")
    expect(names).toEqual(["Ping down", "SSL certificate"])
  })

  it("shows PRTG's message and the acknowledged badge", async () => {
    mountWithRouter(() => <PrtgAlarms connection={CONN} />)
    await screen.findByText("Destination unreachable")
    expect(screen.getByText("Root Authority Trusted is No")).toBeTruthy()
    expect(screen.getAllByText("Acknowledged").length).toBeGreaterThan(0)
  })

  it("links the sensor to its panel on the device's Sensors tab", async () => {
    mountWithRouter(() => <PrtgAlarms connection={CONN} />)
    const link = await screen.findByText("Ping down")
    expect(link.closest("a")?.getAttribute("href")).toBe(
      "/devices/d1?tab=sensors&sensor=s2092"
    )
  })

  it("says so when nothing is down", async () => {
    apiMock.mockImplementation(() =>
      Promise.resolve({ count: 0, next: null, previous: null, results: [] })
    )
    mountWithRouter(() => <PrtgAlarms connection={CONN} />)
    expect(await screen.findByText("No alarms")).toBeTruthy()
  })
})
