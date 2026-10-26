// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgChannels, PrtgSensorPin } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { mountWithRouter } from "./prtg-test-utils"
import { PinnedSensorsCard } from "./sensor-pins"

// The Overview's Sensors card: one tile per pinned channel, linking to the
// sensor's panel, an unpin on each, and nothing at all without pins.

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

function pin(id: string, channel: string, display = "auto"): PrtgSensorPin {
  return {
    id,
    sensor: "s1",
    channel_id: channel,
    display: display as PrtgSensorPin["display"],
    position: 0,
    device: { id: "d1", name: "db-dev01" },
    virtual_machine: null,
    sensor_info: {
      name: "SSL Certificate",
      kind_label: "SSL Certificate",
      state: "degraded",
      status: "Warning",
      paused: false,
      url: "https://prtg.example.com/sensor.htm?id=2091",
    },
    created_at: "2026-10-26T08:00:00Z",
  }
}

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

let pins: PrtgSensorPin[] = []

beforeEach(() => {
  canDo.mockReturnValue(true)
  pins = [pin("p1", "2"), pin("p2", "3"), pin("p3", "2", "value")]
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (path.startsWith("/api/prtg/sensor-pins/")) {
      if (init?.method === "DELETE") return Promise.resolve(null)
      return Promise.resolve({
        count: pins.length,
        next: null,
        previous: null,
        results: pins,
      })
    }
    if (path.includes("/channels/")) return Promise.resolve(CHANNELS)
    return Promise.resolve({})
  })
})
afterEach(cleanup)

function mount() {
  return mountWithRouter(() => (
    <TooltipProvider>
      <PinnedSensorsCard
        parent={{ device: "d1" }}
        sensorLink={(sensor, children) => (
          <a href={`/devices/d1?tab=sensors&sensor=${sensor}`}>{children}</a>
        )}
      />
    </TooltipProvider>
  ))
}

describe("PinnedSensorsCard", () => {
  it("draws each pin as a tile linking to the sensor's panel", async () => {
    mount()
    const card = await screen.findByTestId("prtg-pinned-sensors")
    await waitFor(() => expect(card.querySelector("[role=meter]")).toBeTruthy())
    const tiles = card.querySelectorAll("[data-testid=prtg-pin-tile]")
    expect(tiles).toHaveLength(3)
    // Auto: a gauge for the number, the bar for the lookup; the third
    // asked for the plain value.
    expect(tiles[0].querySelector("[role=meter]")).toBeTruthy()
    expect(tiles[1].querySelector("[data-current]")).toBeTruthy()
    expect(
      tiles[2].querySelector("[data-testid=prtg-channel-value]")?.textContent
    ).toBe("781 #")
    expect(tiles[0].querySelector("a")?.getAttribute("href")).toBe(
      "/devices/d1?tab=sensors&sensor=s1"
    )
    // One channels read for the sensor, however many of its channels pin.
    expect(
      apiMock.mock.calls.filter(([p]) => p.includes("/channels/"))
    ).toHaveLength(1)
  })

  it("unpins from a tile", async () => {
    mount()
    await screen.findByTestId("prtg-pinned-sensors")
    const [unpin] = await screen.findAllByRole("button", {
      name: "Unpin from Overview",
    })
    fireEvent.click(unpin)
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          ([p, i]) =>
            p === "/api/prtg/sensor-pins/p1/" && i?.method === "DELETE"
        )
      ).toBe(true)
    )
  })

  it("offers no unpin without the grant", async () => {
    canDo.mockReturnValue(false)
    mount()
    await screen.findByTestId("prtg-pinned-sensors")
    expect(
      screen.queryAllByRole("button", { name: "Unpin from Overview" })
    ).toHaveLength(0)
  })

  it("is absent without pins", async () => {
    pins = []
    const { container } = mount()
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(
      container.querySelector("[data-testid=prtg-pinned-sensors]")
    ).toBeNull()
  })
})
