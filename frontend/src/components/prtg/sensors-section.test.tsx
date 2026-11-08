// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { mountWithRouter, sensor } from "./prtg-test-utils"
import { PrtgSensorsSection } from "./sensors-tab"
import type { PrtgScope } from "./sensors-tab"

// The sensors section on the IP address, interface and service pages: the
// sensors watching the object, "via <device> in PRTG" linking to the
// device's Sensors tab, cards that say what each watches, and the panel.

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

const IP = { id: "ip1", address: "10.0.0.41", dns_name: "" }
const IFACE = {
  id: "if1",
  name: "Gi1/0/1",
  kind: "interface" as const,
  parent: "d1",
}
const HTTPS = { id: "svc1", name: "HTTPS", ports: "tcp/443" }

const SENSORS = [
  sensor("2094", {
    name: "HTTPS v2",
    ip_address: IP,
    service: HTTPS,
    last_value: "11 msec",
  }),
  sensor("2090", {
    name: "SSL Security Check (Port 443)",
    ip_address: IP,
    service: HTTPS,
    state: "down",
    status: "Down",
    message: "Handshake failed",
  }),
  sensor("3001", {
    name: "(001) Gi1/0/1 Traffic",
    ip_address: IP,
    interface: IFACE,
  }),
]

function page(rows = SENSORS) {
  return { count: rows.length, next: null, previous: null, results: rows }
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) => {
    if (path.startsWith("/api/prtg/sensors/?ip_address=ip1"))
      return Promise.resolve(page())
    if (path.startsWith("/api/prtg/sensors/?interface=if1"))
      return Promise.resolve(page([SENSORS[2]]))
    if (path.startsWith("/api/prtg/sensors/?service=svc1"))
      return Promise.resolve(page(SENSORS.slice(0, 2)))
    if (path.startsWith("/api/prtg/sensors/?service=none"))
      return Promise.resolve(page([]))
    if (path.includes("/channels/"))
      return Promise.resolve({ fetched_at: null, summary: {}, rows: [] })
    if (path.includes("/history/"))
      return Promise.resolve({ range: "1h", channels: [] })
    if (path.startsWith("/api/prtg/sensor-pins/"))
      return Promise.resolve(page([]))
    return Promise.reject(new Error(`unexpected ${path}`))
  })
})
afterEach(cleanup)

function mount(scope: PrtgScope) {
  return mountWithRouter(() => (
    <TooltipProvider>
      <PrtgSensorsSection scope={scope} />
    </TooltipProvider>
  ))
}

describe("PrtgSensorsSection on an object", () => {
  it("lists an address's sensors via the device", async () => {
    mount({ ip_address: "ip1" })
    await waitFor(() =>
      expect(screen.getAllByTestId("prtg-sensor-card")).toHaveLength(3)
    )
    const via = screen.getByTestId("prtg-via")
    expect(via.textContent).toContain("via db-dev01 in PRTG")
    const hrefs = [...via.querySelectorAll("a")].map((a) =>
      a.getAttribute("href")
    )
    // The device's Sensors tab in Danbyte, then the PRTG device in PRTG.
    expect(hrefs).toEqual([
      "/devices/d1?tab=sensors",
      "https://prtg.example.com/device.htm?id=2081",
    ])
    // No PRTG links query: the strip is built from the sensors.
    expect(
      apiMock.mock.calls.some(([p]) => p.startsWith("/api/prtg/links/"))
    ).toBe(false)
  })

  it("an interface's traffic sensor says what it watches", async () => {
    mount({ interface: "if1" })
    await waitFor(() =>
      expect(screen.getAllByTestId("prtg-sensor-card")).toHaveLength(1)
    )
    const chips = screen.getByTestId("prtg-sensor-watches")
    const hrefs = [...chips.querySelectorAll("a")].map((a) =>
      a.getAttribute("href")
    )
    expect(hrefs).toEqual(["/ips/ip1", "/interfaces/if1"])
  })

  it("a service's HTTP and SSL sensors open the panel", async () => {
    mount({ service: "svc1" })
    await waitFor(() =>
      expect(screen.getAllByTestId("prtg-sensor-card")).toHaveLength(2)
    )
    const links = screen.getAllByRole("link", { name: /HTTPS/ })
    expect(links[0].getAttribute("href")).toBe("/services/svc1")
    // A chip navigates; it does not open the card's panel.
    fireEvent.click(links[0])
    expect(screen.queryByTestId("prtg-sensor-panel")).toBeNull()
    fireEvent.click(screen.getAllByTestId("prtg-sensor-card")[1])
    const panel = await screen.findByTestId("prtg-sensor-panel")
    expect(panel.textContent).toContain("SSL Security Check (Port 443)")
  })

  it.each([
    [{ ip_address: "ip1" }, "ip_address", "ip1", "this address's Overview"],
    [{ interface: "if1" }, "interface", "if1", "this interface's Overview"],
    [{ service: "svc1" }, "service", "svc1", "this service's Overview"],
  ] as const)(
    "pins to the object it is on: %o",
    async (scope, key, id, where) => {
      mount(scope)
      await waitFor(() =>
        expect(
          screen.getAllByTestId("prtg-sensor-pin-toggle").length
        ).toBeGreaterThan(0)
      )
      const [toggle] = screen.getAllByTestId("prtg-sensor-pin-toggle")
      expect(toggle.getAttribute("aria-label")).toBe(`Pin to ${where}`)
      await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false))
      // The object's pins, not the sensor's device's.
      expect(
        apiMock.mock.calls.some(([p]) =>
          p.startsWith(`/api/prtg/sensor-pins/?${key}=${id}&`)
        )
      ).toBe(true)
      fireEvent.click(toggle)
      await waitFor(() =>
        expect(
          apiMock.mock.calls.some(
            ([p, i]) => p === "/api/prtg/sensor-pins/" && i?.method === "POST"
          )
        ).toBe(true)
      )
      const [, init] = apiMock.mock.calls.find(
        ([p, i]) => p === "/api/prtg/sensor-pins/" && i?.method === "POST"
      )!
      const body = JSON.parse(String(init!.body))
      expect(body[key]).toBe(id)
      expect(body.device).toBeUndefined()
    }
  )

  it("says so when nothing watches it", async () => {
    mount({ service: "none" })
    expect(await screen.findByText("No PRTG sensor watches this.")).toBeTruthy()
  })
})
