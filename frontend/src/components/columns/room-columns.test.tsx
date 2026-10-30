// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Room } from "@/lib/api"
import { RoomCell } from "@/components/cells/room-cell"
import { buildRoomColumns } from "./room-columns"
import type { RoomColumnId } from "./room-columns"
import { buildCabinetColumns } from "./cabinet-columns"

// A room is a coloured object: its name is its badge in the room list, and
// a device, rack or cabinet that names it shows the same badge, linked to
// the room - never a dot beside a name.

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode
    to: string
    params?: { id?: string }
  }) => <a href={to.replace("$id", params?.id ?? "")}>{children}</a>,
}))
vi.mock("@/components/planning/planned-change-badge", () => ({
  PlannedChangeMarker: () => null,
}))

function room(patch: Partial<Room> = {}): Room {
  return {
    id: "rm1",
    numid: 3,
    name: "Comms 210",
    slug: "comms-210",
    code: "210",
    location: { id: "l1", name: "Floor 2", color: "", icon: "" },
    site: { id: "s1", name: "HQ" },
    status: {
      id: "st1",
      name: "Active",
      color: "#10b981",
      text_color: "#ffffff",
    },
    color: "#2563eb",
    description: "",
    device_count: 4,
    rack_count: 0,
    cabinet_count: 1,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-30T00:00:00Z",
    updated_at: "2026-10-30T00:00:00Z",
    ...patch,
  }
}

function cell(id: RoomColumnId, row: Room) {
  const col = buildRoomColumns({ include: [id] }).find((c) => c.id === id)
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    Room,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

afterEach(cleanup)

describe("room columns", () => {
  it("draws the name as the room's colour badge, linked to the room", () => {
    const el = cell("name", room())
    const pill = screen.getByText("Comms 210")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(pill.style.backgroundColor).toBe("rgb(37, 99, 235)")
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/rooms/rm1")
    expect(el.querySelector(".rounded-full")).toBeNull()
  })

  it("draws a room without a colour as the neutral badge", () => {
    cell("name", room({ color: "" }))
    const pill = screen.getByText("Comms 210")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(pill.style.backgroundColor).toBe("")
  })

  it("draws the status as its pill and counts what stands in it", () => {
    cell("status", room())
    expect(screen.getByText("Active").getAttribute("data-slot")).toBe("badge")
    expect(cell("devices", room()).textContent).toBe("4")
    expect(cell("racks", room()).textContent).toBe("-")
    expect(cell("code", room()).textContent).toBe("210")
    expect(
      cell("location", room()).querySelector("a")?.getAttribute("href")
    ).toBe("/locations/l1")
  })

  it("keeps the order and drops what a page omits", () => {
    const ids = buildRoomColumns({
      omit: ["site", "location"],
      selection: true,
    }).map((c) => c.id)
    expect(ids).toEqual([
      "select",
      "name",
      "code",
      "status",
      "devices",
      "racks",
      "cabinets",
      "tags",
      "description",
      "updated",
    ])
  })
})

describe("the room on a device, rack or cabinet", () => {
  it("renders as the room's badge, linked, and a dash for none", () => {
    const { container } = render(
      <RoomCell
        room={{ id: "rm1", name: "B1-07", code: "", color: "#ef4444" }}
      />
    )
    const pill = screen.getByText("B1-07")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "/rooms/rm1"
    )
    cleanup()
    expect(render(<RoomCell room={null} />).container.textContent).toBe("-")
  })

  it("is a cabinet column after the location", () => {
    const ids = buildCabinetColumns({
      include: ["name", "location", "room", "role"],
    }).map((c) => c.id)
    expect(ids).toEqual(["name", "location", "room", "role"])
  })
})
