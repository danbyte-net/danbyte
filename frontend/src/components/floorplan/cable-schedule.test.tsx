import { afterEach, describe, expect, it, vi } from "vitest"

import type { CableSchedule, CableScheduleRow } from "@/lib/api"

import { layoutQuery, scheduleDrawings, scheduleTable } from "./cable-schedule"
import { traceOption } from "./trace-picker"

// The cable schedule as the CSV/XLSX table: one line per cable in each of
// its groups, then the totals per type and the hidden count.

function row(over: Partial<CableScheduleRow>): CableScheduleRow {
  return {
    id: "c1",
    label: "C-1",
    type: "cat6",
    type_display: "CAT6",
    color: "#0ea5e9",
    status: { name: "Active", color: "#22c55e", text_color: "" },
    a: [
      {
        device: "sw-a",
        port: "ge-1",
        room: "Hall B",
        on_floor: true,
        hidden: false,
      },
    ],
    b: [{ device: null, port: null, room: null, on_floor: true, hidden: true }],
    trays: ["OH-1"],
    route: "OH-1",
    route_source: "stored",
    riser: null,
    computed_m: 10.5,
    length: 10,
    length_unit: "m",
    length_m: 10,
    length_source: "entered",
    notes: "Pull first",
    rooms: ["Hall B"],
    ...over,
  }
}

const data: CableSchedule = {
  group: "tray",
  rows: [
    row({}),
    row({
      id: "c2",
      label: "C-2",
      type: "",
      type_display: "",
      trays: ["OH-1", "OH-2"],
      route: "OH-1 → OH-2 → R1 to Floor 2",
      length: null,
      length_m: null,
      length_source: "",
      notes: "",
    }),
  ],
  groups: [
    { name: "OH-1", rows: ["c1", "c2"] },
    { name: "OH-2", rows: ["c2"] },
  ],
  totals: [
    {
      type: "cat6",
      label: "CAT6",
      count: 1,
      metres: 10,
      unmeasured: 0,
    },
    { type: "", label: "No type", count: 1, metres: 10.5, unmeasured: 0 },
  ],
  total: { count: 2, metres: 20.5, unmeasured: 0 },
  hidden_count: 3,
}

describe("scheduleTable", () => {
  const { columns, rows } = scheduleTable(data)

  it("has the schedule's columns", () => {
    expect(columns.map((c) => c.header)).toEqual([
      "Group",
      "Cable",
      "Type",
      "Colour",
      "Status",
      "A end",
      "A room",
      "B end",
      "B room",
      "Route",
      "Computed (m)",
      "Stored",
      "Source",
      "Notes",
    ])
  })

  it("lists a cable under each tray it rides, hidden ends as Hidden", () => {
    expect(rows.slice(0, 3).map((r) => [r[0], r[1]])).toEqual([
      ["OH-1", "C-1"],
      ["OH-1", "C-2"],
      ["OH-2", "C-2"],
    ])
    expect(rows[0]).toEqual([
      "OH-1",
      "C-1",
      "CAT6",
      "#0ea5e9",
      "Active",
      "sw-a · ge-1",
      "Hall B",
      "Hidden",
      "",
      "OH-1",
      "10.5",
      "10 m",
      "Entered",
      "Pull first",
    ])
    expect(rows[1][9]).toBe("OH-1 → OH-2 → R1 to Floor 2")
  })

  it("ends with the totals per type and the hidden count", () => {
    const tail = rows.slice(3).map((r) => r.slice(0, 5))
    expect(tail).toEqual([
      ["", "", "", "", ""],
      ["Totals", "Type", "Cables", "Metres", "Unmeasured"],
      ["", "CAT6", "1", "10", ""],
      ["", "No type", "1", "10.5", ""],
      ["", "All", "2", "20.5", ""],
      ["Hidden", "3 cables hidden", "", "", ""],
    ])
    for (const r of rows) expect(r).toHaveLength(columns.length)
  })
})

// The PDF's pages: the layout asked for (close-ups and trace pages), each
// page drawn framed to its box - a trace page always without its cables.

const SHEET = { size: "a4", orientation: "landscape" } as const
const OVERVIEW = '<svg viewBox="0 0 800 400"></svg>'

describe("layoutQuery", () => {
  it("asks for close-ups by the overview's box, and trace pages", () => {
    const q = layoutQuery(SHEET, OVERVIEW, {
      closeups: true,
      trace: ["a", "b"],
    })
    expect(Object.fromEntries(q!)).toEqual({
      size: "a4",
      orientation: "landscape",
      closeups: "auto",
      box: "0,0,800,400",
      trace: "a,b",
    })
  })

  it("asks for trace pages alone without an overview", () => {
    const q = layoutQuery(SHEET, null, { closeups: true, trace: ["a"] })
    expect(q!.get("closeups")).toBe("off")
    expect(q!.has("box")).toBe(false)
  })

  it("asks nothing when there is nothing to lay out", () => {
    expect(layoutQuery(SHEET, null, { closeups: true, trace: [] })).toBeNull()
    expect(
      layoutQuery(SHEET, OVERVIEW, { closeups: false, trace: [] })
    ).toBeNull()
  })
})

describe("scheduleDrawings", () => {
  afterEach(() => vi.restoreAllMocks())

  it("draws each close-up as asked and each trace page without cables", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          pages: [
            { label: "A", box: [0, 0, 100, 50], mm_per_px: 0.5, cables: 3 },
          ],
          traces: [
            { label: "T1", cable: "c9", box: [10, 0, 60, 30], mm_per_px: 0.8 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    )
    const draw = vi.fn(() => Promise.resolve("<svg/>"))
    const out = await scheduleDrawings(
      "p1",
      SHEET,
      OVERVIEW,
      { closeups: true, trace: ["c9"], cables: false },
      draw
    )
    expect(out).toEqual({ closeups: { A: "<svg/>" }, traces: { c9: "<svg/>" } })
    expect(draw.mock.calls).toEqual([
      [
        SHEET,
        { box: { x: 0, y: 0, w: 100, h: 50 }, mmPerPx: 0.5 },
        { cables: false },
      ],
      [
        SHEET,
        { box: { x: 10, y: 0, w: 60, h: 30 }, mmPerPx: 0.8 },
        { cables: false },
      ],
    ])
  })
})

describe("traceOption", () => {
  it("names a cable by its label and ends", () => {
    expect(traceOption(row({}))).toBe("C-1 · sw-a · ge-1 → Hidden")
  })
})
