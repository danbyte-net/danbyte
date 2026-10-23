// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext, ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoolingFeed, CoolingSource } from "@/lib/api"
import { buildCoolingSourceColumns } from "./cooling-source-columns"
import type { CoolingSourceColumnId } from "./cooling-source-columns"
import { buildCoolingFeedColumns } from "./cooling-feed-columns"
import type { CoolingFeedColumnId } from "./cooling-feed-columns"

// A cooling source or feed row reads the same on its list and in every
// embedded pane (#434): the status is its catalog pill, the load is heat
// over capacity, and the loop's figures carry their units.

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

const status = {
  id: "st1",
  name: "Active",
  color: "#10b981",
  text_color: "#ffffff",
}

function source(patch: Partial<CoolingSource> = {}): CoolingSource {
  return {
    id: "c1",
    numid: 3,
    name: "CRAH-1",
    site: { id: "s1", name: "HQ" },
    location: { id: "l1", name: "Hall A" },
    type: "crah",
    type_display: "CRAH",
    status,
    fluid: "water",
    fluid_display: "Water",
    rated_capacity_w: 30000,
    redundancy_group: "A",
    device: null,
    comments: "",
    feed_count: 2,
    capacity: {
      available_w: 30000,
      heat_allocated_w: 12000,
      heat_maximum_w: 15000,
      racks: 2,
    },
    tags: [],
    custom_fields: {},
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  }
}

function feed(patch: Partial<CoolingFeed> = {}): CoolingFeed {
  return {
    id: "f1",
    numid: 4,
    name: "Loop A",
    source: { id: "c1", name: "CRAH-1" },
    site: { id: "s1", name: "HQ" },
    rack: { id: "r1", name: "R01" },
    status,
    type: "primary",
    type_display: "Primary",
    rated_capacity_w: 10000,
    flow_rate_lpm: "42.5",
    supply_temp_c: "18.0",
    return_temp_c: null,
    connector: "",
    max_utilization: 80,
    comments: "",
    capacity: {
      available_w: 8000,
      rated_w: 10000,
      heat_allocated_w: 9000,
      heat_maximum_w: 12000,
      redundant: false,
    },
    tags: [],
    custom_fields: {},
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  }
}

function sourceCell(id: CoolingSourceColumnId, row: CoolingSource) {
  const col = buildCoolingSourceColumns({ include: [id] }).find(
    (c) => c.id === id
  )
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    CoolingSource,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

function feedCell(id: CoolingFeedColumnId, row: CoolingFeed) {
  const col = buildCoolingFeedColumns({ include: [id] }).find(
    (c) => c.id === id
  )
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    CoolingFeed,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

const ids = <T,>(cols: ColumnDef<T, unknown>[]) => cols.map((c) => c.id)

afterEach(cleanup)

describe("cooling source columns", () => {
  it("draws the status as its coloured pill, not a dot", () => {
    const el = sourceCell("status", source())
    const pill = screen.getByText("Active")
    expect(pill.getAttribute("data-slot")).toBe("badge")
    expect(el.querySelector(".rounded-full")).toBeNull()
  })

  it("reads the rating and the load in kW", () => {
    expect(sourceCell("rated", source()).textContent).toBe("30 kW")
    expect(
      sourceCell("rated", source({ rated_capacity_w: null })).textContent
    ).toBe("-")
    const load = sourceCell("load", source())
    expect(load.querySelector("[data-slot=cooling-figure]")).toBeTruthy()
    expect(load.textContent).toContain("12 kW / 30 kW")
  })

  it("shows a dash for a source with nothing to measure", () => {
    const el = sourceCell(
      "load",
      source({
        capacity: {
          available_w: 0,
          heat_allocated_w: 0,
          heat_maximum_w: 0,
          racks: 0,
        },
      })
    )
    expect(el.textContent).toBe("-")
  })

  it("keeps to the columns asked for", () => {
    expect(
      ids(buildCoolingSourceColumns({ include: ["numid", "name", "load"] }))
    ).toEqual(["name", "load"])
    expect(
      ids(
        buildCoolingSourceColumns({
          include: ["numid", "name"],
          humanIds: true,
        })
      )
    ).toEqual(["numid", "name"])
  })
})

describe("cooling feed columns", () => {
  it("links the source and draws the status pill", () => {
    const el = feedCell("source", feed())
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "/cooling-sources/c1"
    )
    feedCell("status", feed())
    expect(screen.getByText("Active").getAttribute("data-slot")).toBe("badge")
  })

  it("reads the loop's figures with their units", () => {
    expect(feedCell("flow", feed()).textContent).toBe("42.5 L/min")
    expect(feedCell("supply", feed()).textContent).toBe("18 °C")
    expect(feedCell("return", feed()).textContent).toBe("-")
    expect(feedCell("rated", feed()).textContent).toBe("10 kW")
  })

  it("turns the load red over what the feed delivers", () => {
    const el = feedCell("load", feed())
    expect(el.textContent).toContain("9 kW / 8 kW")
    expect(el.querySelector(".text-destructive")).toBeTruthy()
  })

  it("drops the column a page already is", () => {
    const cols = buildCoolingFeedColumns({
      include: ["name", "source", "rack", "load"],
      omit: ["rack"],
    })
    expect(ids(cols)).toEqual(["name", "source", "load"])
  })
})
