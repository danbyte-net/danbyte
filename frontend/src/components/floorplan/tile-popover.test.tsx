// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanLiveState, FloorPlanTile, Rack } from "@/lib/api"
import {
  DEFAULT_POPOVER_FIELDS,
  POPOVER_FIELDS,
  TilePopover,
  fieldsForTile,
} from "./tile-popover"

// A cabinet tile's popover: the cabinet it links to, and - where a rack's
// shows how many units it uses - how many devices and rails it carries.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    search,
    className,
  }: {
    children: React.ReactNode
    to: string
    search?: Record<string, string>
    className?: string
  }) => (
    <a
      className={className}
      href={`${to}${search ? `?${new URLSearchParams(search).toString()}` : ""}`}
    >
      {children}
    </a>
  ),
}))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(() => new Promise(() => undefined))
})
afterEach(cleanup)

const tile = (patch: Partial<FloorPlanTile> = {}): FloorPlanTile =>
  ({
    id: "t1",
    x: 2,
    y: 2,
    width: 1,
    height: 1,
    orientation: 0,
    tile_type: null,
    role_type: null,
    label: "",
    color: "",
    status: "",
    link_kind: "cabinet",
    linked: { kind: "cabinet", id: "c1", name: "K1", route: "/cabinets/c1" },
    ...patch,
  }) as FloorPlanTile

const cabinetLive: FloorPlanLiveState["tiles"][string] = {
  kind: "cabinet",
  device_count: 5,
  rail_count: 2,
  check: "down",
}

function open(
  t: FloorPlanTile,
  fields: string[],
  live: FloorPlanLiveState["tiles"][string] = cabinetLive,
  rack?: Rack | null
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TilePopover
        target={{ tile: t, x: 10, y: 10, pinned: true }}
        live={live}
        planRack={rack}
        fields={fields}
        onOpenChange={() => undefined}
        renderLinked={(x) => <a href={x.linked!.route}>Open cabinet</a>}
      />
    </QueryClientProvider>
  )
  const dialog = screen.getByRole("dialog")
  return Object.fromEntries(
    [...dialog.querySelectorAll("dl > div")].map((row) => [
      row.querySelector("dt")!.textContent,
      row.querySelector("dd")!,
    ])
  )
}

describe("fieldsForTile", () => {
  it("reads a cabinet's devices and rails where a rack reads its units", () => {
    expect(fieldsForTile(["name", "utilization", "size"], tile())).toEqual([
      "name",
      "device_count",
      "rail_count",
      "size",
    ])
  })

  it("keeps a key the list names on its own in its own place", () => {
    expect(
      fieldsForTile(["utilization", "name", "device_count"], tile())
    ).toEqual(["rail_count", "name", "device_count"])
  })

  it("leaves other tiles' lists alone", () => {
    const rack = tile({
      link_kind: "rack",
      linked: { kind: "rack", id: "r1", name: "R1", route: "/racks/r1" },
    })
    const fields = ["name", "utilization"]
    expect(fieldsForTile(fields, rack)).toBe(fields)
  })
})

describe("TilePopover on a cabinet tile", () => {
  it("shows the cabinet, its devices and rails by default", () => {
    const rows = open(tile(), DEFAULT_POPOVER_FIELDS)
    expect(rows.Name.textContent).toBe("K1")
    expect(
      within(rows.Linked).getByRole("link", { name: "Open cabinet" })
    ).toBeTruthy()
    expect(rows.Devices.textContent).toBe("5")
    expect(rows.Rails.textContent).toBe("2")
    expect(rows.Utilization).toBeUndefined()
  })

  it("names the monitoring state and which way the door faces", () => {
    const rows = open(tile({ orientation: 90 }), ["check", "orientation"])
    expect(rows.Monitoring.textContent.toLowerCase()).toContain("down")
    expect(rows.Facing.textContent).toContain("right")
    cleanup()
    // Facing up is still worth saying for a cabinet: it has a front.
    expect(open(tile(), ["orientation"]).Facing.textContent).toContain("up")
  })

  it("reads the linked cabinet's detail for the object rows", async () => {
    apiMock.mockImplementation((path: string) =>
      path === "/api/cabinets/c1/"
        ? Promise.resolve({
            id: "c1",
            numid: 7,
            description: "Line 3 control",
          })
        : new Promise(() => undefined)
    )
    open(tile(), ["linked_numid", "linked_description"])
    expect(await screen.findByText("#7")).toBeTruthy()
    expect(screen.getByText("Line 3 control")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith("/api/custom-fields/?model=cabinet")
  })
})

describe("TilePopover on a rack tile", () => {
  const rackTile = tile({
    link_kind: "rack",
    linked: { kind: "rack", id: "r1", name: "A01", route: "/racks/r1" },
  })
  const rackLive = (
    power: { available_w: number; allocated_w: number; maximum_w: number },
    used_units = 21
  ): FloorPlanLiveState["tiles"][string] => ({
    kind: "rack",
    used_units,
    u_height: 42,
    power,
    total_weight_kg: 0,
    max_weight_kg: null,
    device_count: 3,
    check: null,
  })

  it("reads power as demand over supply, as the rack page does", () => {
    // It read allocated over nameplate until 0.17.
    const rows = open(
      rackTile,
      ["utilization", "power"],
      rackLive({ available_w: 3_600, allocated_w: 1_200, maximum_w: 2_000 }, 40)
    )
    expect(rows.Power.textContent).toBe("1.2 kW / 3.6 kW")
    expect(rows.Utilization.textContent).toBe("40/42U · 95%")
    // 95.2 %: past the critical line, on the racks' shared scale.
    expect(
      rows.Utilization.querySelector("[data-level]")?.getAttribute("data-level")
    ).toBe("critical")
  })

  it("says No feed, and skips a rack with no power at all", () => {
    const rows = open(
      rackTile,
      ["power"],
      rackLive({ available_w: 0, allocated_w: 0, maximum_w: 900 })
    )
    expect(rows.Power.textContent).toBe("900 Wnameplate · No feed")
    cleanup()
    const none = open(
      rackTile,
      ["name", "power"],
      rackLive({ available_w: 0, allocated_w: 0, maximum_w: 0 })
    )
    expect(none.Power).toBeUndefined()
  })

  // #247: the plan's racks carry their ports; the Ports field reads them.
  const row = (connected: number, total: number, reserved = 0) => ({
    total,
    connected,
    reserved,
    free: total - connected - reserved,
    marked: 0,
  })
  const planRack = (patch: Partial<Rack>) =>
    ({ id: "r1", name: "A01", ...patch }) as Rack

  it("offers Ports, off by default", () => {
    expect(POPOVER_FIELDS.ports.label).toBe("Ports")
    expect(DEFAULT_POPOVER_FIELDS).not.toContain("ports")
  })

  it("reads a rack's ports and panel ports, each opening Port utilization", () => {
    const rows = open(
      rackTile,
      ["ports"],
      rackLive({ available_w: 0, allocated_w: 0, maximum_w: 0 }),
      planRack({ ports: row(70, 114, 4), panel_ports: row(20, 24) })
    )
    const links = within(rows.Ports).getAllByRole("link")
    expect(links.map((a) => a.textContent)).toEqual([
      "74 / 114",
      "20 / 24Panel",
    ])
    for (const a of links)
      expect(a.getAttribute("href")).toBe("/port-utilization?rack=r1")
    // On the racks' shared scale: 83 % of the panel is in use.
    expect(
      links[1].querySelector("[data-level]")?.getAttribute("data-level")
    ).toBe("warn")
  })

  it("leaves out what a rack does not have, and racks the plan has not loaded", () => {
    const live = rackLive({ available_w: 0, allocated_w: 0, maximum_w: 0 })
    const only = open(
      rackTile,
      ["ports"],
      live,
      planRack({ ports: row(3, 15), panel_ports: row(0, 0) })
    )
    expect(within(only.Ports).getAllByRole("link")).toHaveLength(1)
    cleanup()
    expect(
      open(rackTile, ["name", "ports"], live, planRack({ ports: row(0, 0) }))
        .Ports
    ).toBeUndefined()
    cleanup()
    expect(
      open(rackTile, ["name", "ports"], live, undefined).Ports
    ).toBeUndefined()
    cleanup()
    // A cabinet tile has no rack to read.
    expect(open(tile(), ["name", "ports"]).Ports).toBeUndefined()
  })
})
