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

import type * as Api from "@/lib/api"
import type { ObjectReportSchema, TopologyReportRequest } from "@/lib/api"

import {
  ObjectReportDialog,
  initialPrefs,
  topologyRequest,
} from "./object-report"
import type { ReportTarget } from "./object-report"
import type { ReportDrawing } from "./topology/export/export-menu"

// The topology report (api/reports/kinds/topology.py) in the report
// dialog: its sections and columns, each view drawn as the map's Export ▸
// PDF draws it when the report is made, and one PDF or a ZIP for several.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: vi.fn() }))

const cols = (...keys: string[]) => keys.map((key) => ({ key, label: key }))
const SCHEMA: ObjectReportSchema = {
  type: "topology",
  label: "Topology view",
  plural: "Topology views",
  columns: [],
  default_columns: [],
  group_by: [],
  default_group_by: null,
  sections: [
    {
      key: "diagram",
      label: "Diagram",
      kind: "diagram",
      default: true,
      available: true,
      last: false,
      columns: [],
      default_columns: [],
    },
    {
      key: "devices",
      label: "Devices",
      kind: "table",
      default: true,
      available: true,
      last: false,
      columns: cols("name", "status", "site", "serial_number"),
      default_columns: ["name", "status", "site"],
    },
    {
      key: "cables",
      label: "Cabling",
      kind: "table",
      default: true,
      available: false,
      note: "You may not view cabling.",
      last: false,
      columns: [],
      default_columns: [],
    },
  ],
  papers: ["a4", "letter", "a3"],
  limits: {
    objects: 20,
    object_pages: 20,
    section_rows: 500,
    total_rows: 20000,
    columns: 40,
    last: 200,
  },
}

const drawn = (name: string): ReportDrawing => ({
  drawing: { svg: `<svg>${name}</svg>`, title: name, filters: "Site AMS" },
  devices: [`${name}-d1`],
  titleBlock: true,
})

let clicks: HTMLAnchorElement[] = []

beforeEach(() => {
  localStorage.clear()
  clicks = []
  apiMock.mockReset()
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    clicks.push(this)
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function show(target: ReportTarget) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <ObjectReportDialog
        kind="topology"
        target={target}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}

const posts = () =>
  apiMock.mock.calls
    .filter(([p, init]) => init?.method === "POST" && !p.includes("estimate"))
    .map(([p, init]) => ({
      path: p,
      body: JSON.parse(String(init?.body)) as TopologyReportRequest,
    }))

describe("the topology report dialog", () => {
  it("draws the map's view when the report is made and posts it", async () => {
    const draw = vi.fn(async () => drawn("DC1"))
    apiMock.mockImplementation(async (path, init) => {
      if (!init) return SCHEMA
      if (path.includes("estimate"))
        return {
          cells: 4,
          pages: 1,
          seconds: 1,
          mode: "now",
          fits: { now: 1, background: 2 },
        }
      return { url: "/api/topology/report/abcdefghijklmnopqrstuvwx/" }
    })
    show({
      ids: ["v1"],
      scope: "one",
      name: "DC1",
      views: [{ id: "v1", name: "DC1", devices: ["d1", "d2"], draw }],
    })
    expect(await screen.findByText("Cabling")).toBeTruthy()
    expect(screen.getByText("You may not view cabling.")).toBeTruthy()
    // The live estimate is asked before drawing, with the map's devices.
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([p]) => p.includes("estimate"))).toBe(
        true
      )
    )
    const est = apiMock.mock.calls.find(([p]) => p.includes("estimate"))!
    const estBody = JSON.parse(String(est[1]?.body)) as TopologyReportRequest
    expect(estBody.views[0]).toMatchObject({
      svg: "",
      device_ids: ["d1", "d2"],
    })
    expect(draw).not.toHaveBeenCalled()
    expect(screen.queryByText("Output")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /download/i }))
    await waitFor(() => expect(clicks).toHaveLength(1))
    expect(draw).toHaveBeenCalledTimes(1)
    const [{ path, body }] = posts()
    expect(path).toBe("/api/topology/report/?print=1")
    expect(body.views).toEqual([
      {
        view: "v1",
        title: "DC1",
        filters: "Site AMS",
        svg: "<svg>DC1</svg>",
        device_ids: ["DC1-d1"],
      },
    ])
    expect(body.sections).toEqual(["diagram", "devices"])
    expect(body.columns).toEqual({ devices: ["name", "status", "site"] })
    expect(body.options?.title_block).toBe(true)
    expect(clicks[0].download).toMatch(/^dc1-\d{4}-\d\d-\d\d\.pdf$/)
  })

  it("draws several views one at a time and offers a ZIP", async () => {
    const order: string[] = []
    const view = (name: string) => ({
      id: name,
      name,
      draw: vi.fn(async () => {
        order.push(name)
        return drawn(name)
      }),
    })
    apiMock.mockImplementation(async (_path, init) =>
      init ? { url: "/api/topology/report/abcdefghijklmnopqrstuvwx/" } : SCHEMA
    )
    show({
      ids: ["A", "B"],
      scope: "selected",
      views: [view("A"), view("B")],
    })
    expect(await screen.findByText("Output")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "ZIP of PDFs" }))
    fireEvent.click(screen.getByRole("button", { name: /download/i }))
    await waitFor(() => expect(clicks).toHaveLength(1))
    // No estimate before drawing: the saved views' devices are not known.
    expect(apiMock.mock.calls.some(([p]) => p.includes("estimate"))).toBe(false)
    expect(order).toEqual(["A", "B"])
    const [{ body }] = posts()
    expect(body.views.map((v) => v.svg)).toEqual([
      "<svg>A</svg>",
      "<svg>B</svg>",
    ])
    expect(body.options?.output).toBe("zip")
    expect(clicks[0].download).toMatch(/\.zip$/)
  })
})

describe("topologyRequest", () => {
  it("leaves out sections the reader may not view", () => {
    const prefs = initialPrefs(SCHEMA, null)
    const body = topologyRequest(
      {
        ids: ["v"],
        scope: "one",
        views: [{ name: "V", draw: async () => null }],
      },
      prefs,
      SCHEMA,
      ""
    )
    expect(body.sections).toEqual(["diagram", "devices"])
    expect(body.views[0]).toEqual({
      view: null,
      title: "V",
      filters: "",
      svg: "",
      device_ids: [],
    })
    expect(body.options?.output).toBeUndefined()
  })
})
