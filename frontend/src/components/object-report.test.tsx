// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type {
  ObjectReportEstimate,
  ObjectReportRequest,
  ObjectReportSchema,
} from "@/lib/api"

import { BulkExport } from "./bulk-export"
import {
  ObjectReportButton,
  ObjectReportDialog,
  estimateLine,
  initialPrefs,
  readReportPrefs,
  reportExport,
  reportRequest,
} from "./object-report"
import type { ReportTarget } from "./object-report"

// The PDF report of devices, prefixes and IP addresses
// (api/object_report.py): the dialog reads what a report can hold from the
// server, picks the list columns, summary, details for each object and
// their sections, shows a live estimate, posts one request (polling a
// background report until it is ready) and remembers the picks per type in
// this browser. It opens from a detail page's button and from a list's or
// bulk bar's menu.

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))

const SCHEMA: ObjectReportSchema = {
  type: "device",
  label: "Device",
  plural: "Devices",
  columns: [
    { key: "name", label: "Name" },
    { key: "status", label: "Status" },
    { key: "site", label: "Site" },
    { key: "serial_number", label: "Serial number" },
    { key: "cf.owner", label: "Owner" },
  ],
  default_columns: ["name", "status", "site"],
  group_by: [
    { key: "status", label: "Status" },
    { key: "site", label: "Site" },
  ],
  sections: [
    {
      key: "overview",
      label: "Overview",
      kind: "kv",
      default: true,
      available: true,
      last: false,
      columns: [
        { key: "site", label: "Site" },
        { key: "cf.owner", label: "Owner" },
      ],
      default_columns: ["site", "cf.owner"],
    },
    {
      key: "interfaces",
      label: "Interfaces",
      kind: "table",
      default: true,
      available: false,
      note: "You may not view interfaces.",
      last: false,
      columns: [],
      default_columns: [],
    },
    {
      key: "journal",
      label: "Journal",
      kind: "table",
      default: false,
      available: true,
      last: true,
      columns: [{ key: "comments", label: "Comments" }],
      default_columns: ["comments"],
    },
  ],
  papers: ["a4", "letter", "a3"],
  limits: {
    objects: 2000,
    object_pages: 50,
    section_rows: 500,
    total_rows: 20000,
    columns: 40,
    last: 200,
  },
}

let posted: { path: string; body: ObjectReportRequest }[] = []
let estimated: ObjectReportRequest[] = []
const NOW: ObjectReportEstimate = {
  cells: 120,
  pages: 0,
  seconds: 0.7,
  mode: "now",
  fits: { now: 12800, background: 130000 },
}
let estimate: ObjectReportEstimate | Error = NOW

/** The estimate endpoint's answer, or its refusal. */
function answerEstimate(init?: RequestInit) {
  estimated.push(JSON.parse(String(init?.body)) as ObjectReportRequest)
  return estimate instanceof Error
    ? Promise.reject(estimate)
    : Promise.resolve(estimate)
}

beforeEach(() => {
  localStorage.clear()
  posted = []
  estimated = []
  estimate = NOW
  apiMock.mockReset()
  toastMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (path.includes("estimate=1")) return answerEstimate(init)
    if (init?.method === "POST") {
      posted.push({
        path,
        body: JSON.parse(String(init.body)) as ObjectReportRequest,
      })
      return Promise.resolve({ url: "/api/devices/report/file/tok/" })
    }
    return Promise.resolve(SCHEMA)
  })
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const many: ReportTarget = {
  ids: ["d1", "d2", "d3"],
  filters: { search: "sw" },
  scope: "filtered",
}

describe("reportRequest", () => {
  it("sends the list table and the summary for many objects", () => {
    const prefs = initialPrefs(SCHEMA, null)
    const body = reportRequest(many, prefs, SCHEMA, "")
    expect(body.ids).toEqual(["d1", "d2", "d3"])
    expect(body.filters).toEqual({ search: "sw" })
    expect(body.columns).toEqual({ list: ["name", "status", "site"] })
    expect(body.options).toMatchObject({
      list_table: true,
      per_object: false,
      include_summary: true,
    })
  })

  it("sends one object's sections, leaving out the unavailable", () => {
    const prefs = initialPrefs(SCHEMA, null)
    const body = reportRequest(
      { ids: ["d1"], scope: "one", name: "sw-a" },
      prefs,
      SCHEMA,
      "  Core switch  "
    )
    expect(body.sections).toEqual(["overview"])
    expect(body.columns).toEqual({ overview: ["site", "cf.owner"] })
    expect(body.options).toMatchObject({
      title: "Core switch",
      list_table: false,
      per_object: true,
      include_summary: false,
      group_by: null,
    })
  })

  it("starts from the remembered picks that still exist", () => {
    const prefs = initialPrefs(SCHEMA, {
      paper: "letter",
      orientation: "portrait",
      sections: ["journal", "gone"],
      columns: { list: ["serial_number", "nope", "name"] },
      groupBy: "site",
      perObject: true,
      last: 999,
    })
    expect(prefs.paper).toBe("letter")
    expect(prefs.sections).toEqual(["journal"])
    expect(prefs.columns.list).toEqual(["serial_number", "name"])
    expect(prefs.columns.overview).toEqual(["site", "cf.owner"])
    expect(prefs.groupBy).toBe("site")
    expect(prefs.last).toBe(200)
  })

  it("sends show_ips only where the schema offers it", () => {
    const prefs = { ...initialPrefs(SCHEMA, null), showIps: true }
    expect(
      reportRequest(many, prefs, SCHEMA, "").options?.show_ips
    ).toBeUndefined()
    expect(
      reportRequest(many, prefs, { ...SCHEMA, show_ips: true }, "").options
        ?.show_ips
    ).toBe(true)
  })
})

describe("ObjectReportDialog", () => {
  it("posts the picks, says Generating… and remembers them", async () => {
    let finish: (v: unknown) => void = () => {}
    apiMock.mockImplementation((path, init) => {
      if (path.includes("estimate=1")) return answerEstimate(init)
      if (init?.method === "POST") {
        posted.push({
          path,
          body: JSON.parse(String(init.body)) as ObjectReportRequest,
        })
        return new Promise((resolve) => (finish = resolve))
      }
      return Promise.resolve(SCHEMA)
    })
    const onOpenChange = vi.fn()
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={onOpenChange}
      />
    )
    await screen.findByText("List columns", { selector: "label" })
    expect(screen.getByText("3 devices in the list")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Letter" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Summary" }))
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(screen.getByRole("button", { name: /Generating…/ })).toBeTruthy()
    finish({ url: "/api/devices/report/file/tok/" })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(posted[0].path).toBe("/api/devices/report/?print=1")
    expect(posted[0].body.options).toMatchObject({
      paper: "letter",
      include_summary: false,
    })
    expect(readReportPrefs("device")).toMatchObject({
      paper: "letter",
      includeSummary: false,
    })
  })

  it("shows a section the reader may not view as unavailable", async () => {
    wrap(
      <ObjectReportDialog
        kind="device"
        target={{ ids: ["d1"], scope: "one", name: "sw-a" }}
        open
        onOpenChange={() => {}}
      />
    )
    const box = await screen.findByRole("checkbox", { name: "Interfaces" })
    expect((box as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("You may not view interfaces.")).toBeTruthy()
    // One object: no list columns or summary.
    expect(screen.queryByText("List columns")).toBeNull()
  })

  it("refuses more objects than a report lists", async () => {
    wrap(
      <ObjectReportDialog
        kind="device"
        target={{
          ids: Array.from({ length: 2001 }, (_, i) => `d${i}`),
          scope: "selected",
        }}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByRole("alert")
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: /Download/ })
        .disabled
    ).toBe(true)
  })
})

const downloadButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: /Download/ })
const printButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: /Print/ })

describe("live estimate", () => {
  it("says what the report costs and where it renders", () => {
    const plain = { showIps: false, details: false }
    expect(estimateLine(NOW, plain)).toBe("About 120 cells")
    expect(
      estimateLine({ ...NOW, cells: 14207, mode: "background" }, plain)
    ).toBe("About 14,200 cells · renders in the background")
    expect(
      estimateLine(
        { ...NOW, cells: 150000, mode: "too_large" },
        { showIps: true, details: true }
      )
    ).toBe(
      "Too large: 150,000 cells, 130,000 fit · leave out Show IPs or the details or some rows or columns"
    )
  })

  it("shows the line under the options, following the picks", async () => {
    estimate = { ...NOW, cells: 14207, seconds: 25, mode: "background" }
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByText("About 14,200 cells · renders in the background")
    expect(estimated[0].columns?.list).toEqual(["name", "status", "site"])
    expect(downloadButton().disabled).toBe(false)
    expect(printButton().disabled).toBe(false)
    fireEvent.click(screen.getByRole("checkbox", { name: "Summary" }))
    await waitFor(() => expect(estimated).toHaveLength(2))
    expect(estimated[1].options?.include_summary).toBe(false)
  })

  it("disables Download and Print when too large", async () => {
    estimate = {
      ...NOW,
      cells: 150000,
      mode: "too_large",
      detail: "This report is too large to render in time.",
    }
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByText(/^Too large: 150,000 cells/)
    expect(downloadButton().disabled).toBe(true)
    expect(printButton().disabled).toBe(true)
  })

  it("shows the server's refusal and disables", async () => {
    estimate = new ApiError(400, {
      detail: "A report gives details for at most 50 devices.",
    })
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByText("A report gives details for at most 50 devices.")
    expect(downloadButton().disabled).toBe(true)
  })

  it("says nothing and stays enabled when the estimate fails", async () => {
    estimate = new ApiError(503, { detail: "Busy" })
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await waitFor(() => expect(estimated).toHaveLength(1))
    expect(screen.queryByText("Busy")).toBeNull()
    expect(downloadButton().disabled).toBe(false)
  })
})

describe("details for each object", () => {
  it("is a tick under Include; its sections show only when ticked", async () => {
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    const box = await screen.findByRole("checkbox", {
      name: "Details for each device",
    })
    expect(screen.queryByText("One page per object")).toBeNull()
    expect(screen.queryByText("Detail sections")).toBeNull()
    expect(screen.queryByRole("checkbox", { name: "Overview" })).toBeNull()
    fireEvent.click(box)
    expect(screen.getByText("Detail sections")).toBeTruthy()
    expect(screen.getByRole("checkbox", { name: "Overview" })).toBeTruthy()
    fireEvent.click(downloadButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.options?.per_object).toBe(true)
    expect(posted[0].body.sections).toEqual(["overview"])
  })

  it("names the type", async () => {
    wrap(
      <ObjectReportDialog
        kind="ipaddress"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByRole("checkbox", {
      name: "Details for each IP address",
    })
  })
})

describe("background report", () => {
  const STATUS = "/api/devices/report/job/tok/"
  const FILE = "/api/devices/report/job/tok/file/"

  function serve(states: unknown[]) {
    let polls = 0
    apiMock.mockImplementation((path, init) => {
      if (path.includes("estimate=1")) return answerEstimate(init)
      if (init?.method === "POST") {
        posted.push({
          path,
          body: JSON.parse(String(init.body)) as ObjectReportRequest,
        })
        return Promise.resolve({
          job: "tok",
          status: STATUS,
          state: "queued",
          seconds: 30,
        })
      }
      if (path === STATUS)
        return Promise.resolve(states[Math.min(polls++, states.length - 1)])
      return Promise.resolve(SCHEMA)
    })
  }

  it("shows progress, then downloads when ready", async () => {
    serve([
      { state: "running", progress: 40 },
      { state: "done", url: FILE },
    ])
    const saved: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      saved.push(this.getAttribute("href") ?? "")
    })
    const onOpenChange = vi.fn()
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={onOpenChange}
      />
    )
    await screen.findByText("List columns", { selector: "label" })
    fireEvent.click(downloadButton())
    await screen.findByRole(
      "button",
      { name: /Generating… 40%/ },
      { timeout: 4000 }
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false), {
      timeout: 5000,
    })
    expect(saved).toEqual([`${FILE}?download=1`])
    expect(toastMock).not.toHaveBeenCalled()
  }, 12_000)

  it("says why a job failed", async () => {
    serve([{ state: "failed", detail: "The report took too long." }])
    const onOpenChange = vi.fn()
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={onOpenChange}
      />
    )
    await screen.findByText("List columns", { selector: "label" })
    fireEvent.click(downloadButton())
    await waitFor(() => expect(toastMock).toHaveBeenCalled(), {
      timeout: 4000,
    })
    expect((toastMock.mock.calls[0][0] as Error).message).toBe(
      "The report took too long."
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(downloadButton().textContent).toContain("Download")
  }, 8_000)
})

describe("entry points", () => {
  it("a detail page's button opens the dialog on its object", async () => {
    wrap(<ObjectReportButton kind="prefix" id="p1" name="10.0.0.0/24" />)
    fireEvent.click(screen.getByRole("button", { name: /PDF report…/ }))
    await screen.findByText("10.0.0.0/24")
    expect(apiMock).toHaveBeenCalledWith("/api/prefixes/report/")
  })

  it("a bulk bar's Export menu lists the PDF report", () => {
    const open = vi.fn()
    render(
      <BulkExport
        ioType="device"
        ids={["d1", "d2"]}
        extraExports={[
          reportExport(open, () => ({ ids: ["d1", "d2"], scope: "selected" })),
        ]}
      />
    )
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Export" }),
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF report…" }))
    expect(open).toHaveBeenCalledWith({ ids: ["d1", "d2"], scope: "selected" })
  })
})
