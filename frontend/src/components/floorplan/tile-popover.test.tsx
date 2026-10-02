// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanLiveState, FloorPlanTile } from "@/lib/api"
import {
  DEFAULT_POPOVER_FIELDS,
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

function open(t: FloorPlanTile, fields: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <TilePopover
        target={{ tile: t, x: 10, y: 10, pinned: true }}
        live={cabinetLive}
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
