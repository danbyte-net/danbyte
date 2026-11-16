// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CableScheduleRow, FloorPlanReportTables } from "@/lib/api"
import { downloadBlob } from "@/lib/table-export"
import type * as TableExport from "@/lib/table-export"

import { ReportDialog, reportOptions } from "./report-dialog"
import type { DrawSheet } from "./report-dialog"
import {
  areaBox,
  calloutsMarkup,
  clampBox,
  reportBody,
  reportScale,
  reportTable,
  withOverlay,
} from "./report"
import type { AreaShape } from "./shapes"

// The floor plan's Export… dialog: what (this view, the floor, a room or
// area, the building), the paper and what to include - posted as one
// report request whose scope the server checks; CSV and XLSX of the tables.

vi.mock("@/lib/table-export", async (load) => ({
  ...(await load<typeof TableExport>()),
  downloadBlob: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn() },
}))

const LINK = "/api/floor-plans/p1/export/report/abcdefghijklmnopqrstuvwxyz0123/"
let posted: { url: string; body: Record<string, unknown> }[] = []

function answer(body: unknown) {
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    posted.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  })
}

beforeEach(() => {
  localStorage.clear()
  posted = []
  vi.mocked(downloadBlob).mockClear()
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const draw = vi.fn<DrawSheet>(({ floor }) =>
  Promise.resolve({ floor: floor ?? "p1", svg: "<svg/>" })
)

function dialog(over: Partial<React.ComponentProps<typeof ReportDialog>> = {}) {
  draw.mockClear()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ReportDialog
        planId="p1"
        name="Demo tower B1"
        open
        onOpenChange={() => {}}
        areas={[
          { id: "a1", name: "Server room", kind: "room" },
          { id: "a2", name: "Plant room", kind: "room" },
        ]}
        levels={[
          { id: "f0", name: "B1" },
          { id: "p1", name: "Ground" },
        ]}
        screenBox={() => ({ x: 40, y: 80, w: 400, h: 200 })}
        hiddenTiles={["t9"]}
        draw={draw}
        {...over}
      />
    </QueryClientProvider>
  )
}

/** Answers by URL: the schedule's rows, the layout of trace pages, the
 * report's tables and its print link. */
function answerByUrl(routes: Record<string, unknown>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    const u = String(url)
    posted.push({
      url: u,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    })
    const key = Object.keys(routes).find((k) => u.includes(k))
    return Promise.resolve(
      new Response(JSON.stringify(key ? routes[key] : {}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  })
}

function scheduleRow(id: string, label: string): CableScheduleRow {
  return {
    id,
    label,
    type: "smf",
    type_display: "OS2",
    color: "",
    status: null,
    a: [
      { device: "leaf", port: "e1", room: "", on_floor: true, hidden: false },
    ],
    b: [
      { device: "spine", port: "e2", room: "", on_floor: true, hidden: false },
    ],
    trays: [],
    route: "",
    route_source: "",
    riser: null,
    computed_m: null,
    length: null,
    length_unit: "m",
    length_m: null,
    length_source: "",
    notes: "",
    rooms: [],
  }
}

const tab = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }))
const check = (name: string) =>
  fireEvent.click(screen.getByRole("checkbox", { name }))

describe("ReportDialog", () => {
  it("posts the whole floor with its one sheet", async () => {
    answer({ url: LINK })
    dialog()
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].url).toBe("/api/floor-plans/p1/export/report/?print=1")
    expect(posted[0].body).toEqual({
      scope: "floor",
      include: ["plan"],
      hidden_tiles: ["t9"],
      paper: { size: "a3", orientation: "landscape" },
      sheets: [{ floor: "p1", svg: "<svg/>" }],
    })
    expect(draw).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "floor", floor: undefined })
    )
  })

  it("posts bundles: the sheets drawn without cables", async () => {
    answer({ url: LINK })
    dialog()
    tab("Bundles")
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.cables).toBe("bundles")
    expect(draw).toHaveBeenCalledWith(
      expect.objectContaining({ cables: false })
    )
  })

  it("adds a trace page per cable selected on the plan", async () => {
    const planSvg = vi.fn((_p: unknown, box?: unknown) =>
      Promise.resolve(box ? "<svg viewBox='0 0 10 10'/>" : null)
    )
    answerByUrl({
      "/cable-schedule/closeups/": {
        pages: [],
        traces: [
          { label: "T1", cable: "c1", box: [0, 0, 400, 200], mm_per_px: 0.2 },
        ],
      },
      "/cable-schedule/": {
        rows: [scheduleRow("c1", "C-1"), scheduleRow("c2", "C-2")],
      },
      "/export/report/": { url: LINK },
    })
    dialog({ planSvg, selectedCables: ["c1", "gone"] })
    check("Cable schedule")
    expect(
      screen
        .getByRole("checkbox", { name: "Trace pages" })
        .getAttribute("aria-checked")
    ).toBe("true")
    await waitFor(() => expect(screen.getByText("C-1")).toBeTruthy())
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() =>
      expect(
        posted.some((p) => p.url.includes("/export/report/?print=1"))
      ).toBe(true)
    )
    const layout = posted.find((p) => p.url.includes("/closeups/"))!
    expect(layout.url).toContain("trace=c1")
    expect(layout.url).toContain("closeups=off")
    expect(layout.url).not.toContain("gone")
    expect(planSvg).toHaveBeenCalledWith(
      { size: "a3", orientation: "landscape" },
      { box: { x: 0, y: 0, w: 400, h: 200 }, mmPerPx: 0.2 },
      { cables: false }
    )
    const report = posted.find((p) =>
      p.url.includes("/export/report/?print=1")
    )!
    expect(report.body.trace).toEqual(["c1"])
    expect(report.body.trace_svgs).toEqual({ c1: "<svg viewBox='0 0 10 10'/>" })
  })

  it("posts this view with the screen's box", async () => {
    answer({ url: LINK })
    dialog()
    tab("This view")
    check("Inventory")
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body).toMatchObject({
      scope: "view",
      box: [40, 80, 400, 200],
      include: ["plan", "inventory"],
    })
  })

  it("posts a room by its id", async () => {
    answer({ url: LINK })
    dialog()
    tab("Room / area")
    expect(screen.getByText("Server room")).toBeTruthy()
    check("Cable schedule")
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body).toMatchObject({
      scope: "area",
      area: "a1",
      include: ["plan", "cables"],
    })
    expect(posted[0].body).not.toHaveProperty("box")
  })

  it("draws a sheet per level of the building, in order", async () => {
    answer({ url: LINK })
    dialog()
    tab("Building")
    for (const name of ["Cable schedule", "Inventory", "Ports summary"])
      check(name)
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(draw.mock.calls.map((c) => c[0].floor)).toEqual(["f0", "p1"])
    const body = posted[0].body
    expect(body.scope).toBe("building")
    expect(body.include).toEqual(["plan", "cables", "inventory", "ports"])
    expect(body).not.toHaveProperty("hidden_tiles")
    expect((body.sheets as { floor: string }[]).map((s) => s.floor)).toEqual([
      "f0",
      "p1",
    ])
  })

  it("leaves out the plan when it is not wanted", async () => {
    answer({ url: LINK })
    dialog()
    check("Plan drawing")
    check("Inventory")
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(draw).not.toHaveBeenCalled()
    expect(posted[0].body).not.toHaveProperty("sheets")
    expect(posted[0].body.include).toEqual(["inventory"])
  })

  it("needs something to include", () => {
    dialog()
    check("Plan drawing")
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Download/ })
        .disabled
    ).toBe(true)
  })

  it("offers only the scopes the plan has", () => {
    dialog({ areas: [], levels: null, screenBox: undefined })
    expect(screen.queryByRole("button", { name: "This view" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Room / area" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Building" })).toBeNull()
    expect(screen.getByRole("button", { name: "Whole floor" })).toBeTruthy()
  })

  it("makes the CSV from the tables", async () => {
    const tables: FloorPlanReportTables = {
      title: "Demo tower · B1",
      scope: "Whole floor",
      levels: ["B1"],
      inventory: {
        groups: [
          {
            name: "Server room",
            rows: [
              {
                kind: "rack",
                id: "r1",
                name: "R01",
                parent: null,
                role: null,
                type: "",
                status: { name: "Active", color: "#22c55e", text_color: "" },
                holder: "",
                position: "",
                serial: "",
                asset_tag: "",
                room: "Server room",
                level: "B1",
              },
            ],
          },
        ],
        count: { racks: 1, cabinets: 0, devices: 0 },
        hidden_count: 2,
      },
    }
    answer(tables)
    dialog()
    tab("CSV")
    expect(screen.queryByRole("checkbox", { name: "Plan drawing" })).toBeNull()
    check("Inventory")
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(downloadBlob).toHaveBeenCalled())
    expect(posted[0].url).toBe("/api/floor-plans/p1/export/report/tables/")
    expect(posted[0].body).toEqual({
      scope: "floor",
      include: ["inventory"],
      hidden_tiles: ["t9"],
    })
    const csv = String(vi.mocked(downloadBlob).mock.calls[0][2])
    expect(csv).toContain("R01")
    expect(csv).toContain("2 hidden")
  })
})

describe("report helpers", () => {
  const plan = { grid_width: 30, grid_height: 20, cell_mm: 600 }

  it("cuts the screen's box to the plan", () => {
    expect(clampBox({ x: -100, y: -50, w: 500, h: 300 }, plan)).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 250,
    })
    expect(clampBox({ x: 5000, y: 0, w: 10, h: 10 }, plan)).toBeNull()
  })

  it("frames a room with its margin, inside the plan", () => {
    const area = {
      kind: "area",
      id: "a1",
      shape: "rect",
      x: 1,
      y: 2,
      width: 4,
      height: 3,
      rotation: 0,
      points: [],
    } as unknown as AreaShape
    expect(areaBox(area, plan)).toEqual({ x: 0, y: 0, w: 280, h: 280 })
  })

  it("scales a box to the sheet", () => {
    const a3 = { size: "a3", orientation: "landscape" } as const
    // 400 mm across; 420 - 20 = 400.
    expect(reportScale({ x: 0, y: 0, w: 4000, h: 100 }, a3)).toBeCloseTo(0.1)
  })

  it("keeps the scope's own fields only", () => {
    const o = reportOptions({
      scope: "area",
      include: new Set(["inventory", "plan"]),
      paper: { size: "a4", orientation: "portrait" },
      area: "a1",
      box: { x: 1, y: 2, w: 3, h: 4 },
    })
    expect(reportBody(o, [])).toEqual({
      scope: "area",
      area: "a1",
      include: ["plan", "inventory"],
      paper: { size: "a4", orientation: "portrait" },
      sheets: [],
    })
  })

  it("draws the screen's callouts on paper", () => {
    const markup = calloutsMarkup(
      [
        {
          id: "t1",
          name: "R<1>",
          lines: [
            {
              key: "status",
              label: "Status",
              value: "Active",
              color: "#22c55e",
            },
          ],
          at: [2, 3],
          size: { w: 80, h: 40 },
          side: "right",
          leader: [
            [2, 3],
            [1, 3],
          ],
        },
      ],
      2
    )
    expect(markup).toContain("R&lt;1&gt;")
    expect(markup).toContain('fill="#22c55e"')
    expect(markup).toContain("scale(0.5)")
    expect(withOverlay('<svg a="1"><g/></svg>', "<x/>")).toBe(
      '<svg a="1"><g/><x/></svg>'
    )
  })

  it("stacks the tables for CSV", () => {
    const { rows } = reportTable({
      title: "T",
      scope: "Building",
      levels: [],
      ports: {
        rows: [
          {
            device: "sw1",
            device_id: "d1",
            port: "ge-0",
            cable: "C-1",
            cable_color: "",
            far: "Hidden",
          },
        ],
        hidden_count: 0,
        truncated: false,
      },
    })
    expect(rows[0][0]).toBe("Ports")
    expect(rows[1].slice(0, 4)).toEqual(["Device", "Port", "Cable", "Far end"])
    expect(rows[2].slice(0, 4)).toEqual(["sw1", "ge-0", "C-1", "Hidden"])
  })
})
