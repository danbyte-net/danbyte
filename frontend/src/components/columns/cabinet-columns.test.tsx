// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext, ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Cabinet } from "@/lib/api"
import { buildCabinetColumns } from "./cabinet-columns"
import type { CabinetColumnId } from "./cabinet-columns"

// A cabinet row reads the same on /cabinets and in every embedded pane, so the
// cells are pinned here: the status and the role are their catalog colour as a
// pill (never a dot beside a name), and the sizes read the way enclosure
// datasheets give them.

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

function cabinet(patch: Partial<Cabinet> = {}): Cabinet {
  return {
    id: "c1",
    numid: 7,
    name: "dist-board-1",
    facility_id: "=UH1+K1",
    site: { id: "s1", name: "HQ" },
    location: { id: "l1", name: "Plant room" },
    role: {
      id: "r1",
      numid: 1,
      name: "Distribution",
      slug: "dist",
      color: "#2563eb",
    },
    cabinet_type: {
      id: "t1",
      numid: 1,
      name: "AE 1060.500",
      manufacturer: { id: "m1", name: "Rittal" },
      inner_width_mm: 525,
      inner_height_mm: 650,
      outer_width_mm: 600,
      outer_height_mm: 700,
      outer_depth_mm: 210,
    },
    status: {
      id: "st1",
      name: "Active",
      color: "#10b981",
      text_color: "#ffffff",
    },
    inner_width_mm: 525,
    inner_height_mm: 650,
    outer_width_mm: 600,
    outer_height_mm: 700,
    outer_depth_mm: 210,
    description: "",
    document_count: 0,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  }
}

/** Render one column's cell for a row, the way DataTable would. */
function cell(id: CabinetColumnId, row: Cabinet) {
  const col = buildCabinetColumns({ include: [id] }).find((c) => c.id === id)
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    Cabinet,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

const ids = (cols: ColumnDef<Cabinet, unknown>[]) => cols.map((c) => c.id)

afterEach(cleanup)

describe("cabinet columns", () => {
  it("draws the status as its coloured pill, not a dot", () => {
    const el = cell("status", cabinet())
    const pill = screen.getByText("Active")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(pill.style.backgroundColor).toBe("rgb(16, 185, 129)")
    // No dot-plus-name: nothing round sits beside the name.
    expect(el.querySelector(".rounded-full")).toBeNull()
    expect(el.textContent).toBe("Active")
  })

  it("shows a dash for a cabinet without a status", () => {
    const el = cell("status", cabinet({ status: null }))
    expect(el.querySelector("[data-slot=badge]")).toBeNull()
    expect(el.textContent).toBe("-")
  })

  it("draws the role as its coloured badge, linked to the role", () => {
    const el = cell("role", cabinet())
    const pill = screen.getByText("Distribution")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(pill.style.backgroundColor).toBe("rgb(37, 99, 235)")
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "/cabinet-roles/r1"
    )
  })

  it("reads the type with its maker", () => {
    const el = cell("type", cabinet())
    expect(el.textContent).toBe("Rittal AE 1060.500")
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "/cabinet-types/t1"
    )
  })

  it("reads the box as W×H×D and the plate as W×H", () => {
    expect(cell("size", cabinet()).textContent).toBe("600×700×210 mm")
    expect(cell("plate", cabinet()).textContent).toBe("525×650 mm")
    // Depth unknown: the box still reads; width or height unknown: a dash.
    expect(cell("size", cabinet({ outer_depth_mm: null })).textContent).toBe(
      "600×700 mm"
    )
    expect(cell("size", cabinet({ outer_height_mm: null })).textContent).toBe(
      "-"
    )
  })

  it("exports the sizes as the text the cells show", () => {
    const cols = buildCabinetColumns({ include: ["size", "plate"] })
    const values = cols.map((c) => c.meta?.export?.value(cabinet()))
    expect(values).toEqual(["600×700×210 mm", "525×650 mm"])
  })

  it("keeps the embedded panes to the columns they ask for", () => {
    const embedded: CabinetColumnId[] = [
      "name",
      "site",
      "location",
      "role",
      "type",
      "status",
      "size",
      "plate",
    ]
    // A location's own page drops the site and location it already is.
    expect(
      ids(
        buildCabinetColumns({ include: embedded, omit: ["site", "location"] })
      )
    ).toEqual(["name", "role", "type", "status", "size", "plate"])
    // The "#" column only exists with human ids on.
    expect(ids(buildCabinetColumns({ include: ["numid", "name"] }))).toEqual([
      "name",
    ])
    expect(
      ids(buildCabinetColumns({ include: ["numid", "name"], humanIds: true }))
    ).toEqual(["numid", "name"])
  })
})
