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
  Me,
  ObjectReportEstimate,
  ObjectReportRequest,
  ObjectReportSchema,
  SensitivityLabelRef,
} from "@/lib/api"

import { BulkExport } from "./bulk-export"
import {
  ObjectReportButton,
  ObjectReportDialog,
  coverBackgroundItems,
  coverSubtitle,
  estimateLine,
  initialPrefs,
  readReportPrefs,
  reportExport,
  reportRequest,
  writeReportPrefs,
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
// The settings link is a router Link; a plain anchor shows where it goes.
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    to,
    hash,
    children,
    ...rest
  }: {
    to: string
    hash?: string
    children: ReactNode
  }) => (
    <a href={`${to}${hash ? `#${hash}` : ""}`} {...rest}>
      {children}
    </a>
  ),
}))

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

// The label picker is a cmdk combobox: it measures and scrolls; jsdom has
// neither.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}

/** The tenant's sensitivity labels the reader may view, and who they are. */
let labels: SensitivityLabelRef[] = []
let me: Partial<Me> = { is_authenticated: true, perms: [], permissions: {} }

/** A GET: the reader, the labels picker, else the report's schema. */
function get(path: string, schema: ObjectReportSchema = SCHEMA) {
  if (path.startsWith("/api/me/")) return Promise.resolve(me)
  if (path.startsWith("/api/sensitivity-labels/"))
    return Promise.resolve({
      count: labels.length,
      next: null,
      previous: null,
      results: labels,
    })
  return Promise.resolve(schema)
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
  labels = []
  me = { is_authenticated: true, perms: [], permissions: {} }
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
    return get(path)
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

  it("starts a prefix report grouped by VRF, keeping No grouping", () => {
    const schema = {
      ...SCHEMA,
      group_by: [...SCHEMA.group_by, { key: "vrf", label: "VRF" }],
      default_group_by: "vrf",
    }
    expect(initialPrefs(schema, null).groupBy).toBe("vrf")
    // Remembered from before the default: still the default.
    expect(initialPrefs(schema, { groupBy: null }).groupBy).toBe("vrf")
    expect(initialPrefs(schema, { groupBy: "site" }).groupBy).toBe("site")
    // "No grouping" picked and remembered stays picked, and is sent as null.
    writeReportPrefs("prefix", { ...initialPrefs(schema, null), groupBy: null })
    const kept = initialPrefs(schema, readReportPrefs("prefix"))
    expect(kept.groupBy).toBeNull()
    expect(reportRequest(many, kept, schema, "").options?.group_by).toBeNull()
    expect(initialPrefs(SCHEMA, null).groupBy).toBeNull()
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
      return get(path)
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

  it("offers Hardware unticked, with no column picker, and sends it once ticked", async () => {
    const hardware = {
      key: "hardware",
      label: "Hardware",
      kind: "hardware",
      default: false,
      available: true,
      last: false,
      columns: [],
      default_columns: [],
    }
    const schema: ObjectReportSchema = {
      ...SCHEMA,
      sections: [SCHEMA.sections[0], hardware, ...SCHEMA.sections.slice(1)],
    }
    apiMock.mockImplementation((path, init) => {
      if (path.includes("estimate=1")) return answerEstimate(init)
      if (init?.method === "POST") {
        posted.push({
          path,
          body: JSON.parse(String(init.body)) as ObjectReportRequest,
        })
        return Promise.resolve({ url: "/api/devices/report/file/tok/" })
      }
      return get(path, schema)
    })
    expect(initialPrefs(schema, null).sections).not.toContain("hardware")
    wrap(
      <ObjectReportDialog
        kind="device"
        target={{ ids: ["d1"], scope: "one", name: "sw-a" }}
        open
        onOpenChange={() => {}}
      />
    )
    const box = await screen.findByRole("checkbox", { name: "Hardware" })
    expect(box.getAttribute("aria-checked")).toBe("false")
    fireEvent.click(box)
    expect(box.getAttribute("aria-checked")).toBe("true")
    expect(
      screen.queryByRole("button", { name: "Hardware columns" })
    ).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /Download/ }))
    await waitFor(() => expect(posted).toHaveLength(1))
    // In the schema's order: after Overview.
    expect(posted[0].body.sections).toEqual(["overview", "hardware"])
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

describe("cover page", () => {
  const COVERED: ObjectReportSchema = {
    ...SCHEMA,
    cover: { project: "Acme", upload: true, background: "waves" },
  }

  it("sends nothing about a cover until it is ticked", () => {
    const body = reportRequest(many, initialPrefs(SCHEMA, null), SCHEMA, "")
    expect(body.options?.cover).toBeUndefined()
  })

  it("sends the cover's text and image when ticked", () => {
    const prefs = {
      ...initialPrefs(COVERED, null),
      cover: true,
      coverProject: " Falcon ",
      coverBackground: "upload" as const,
    }
    expect(reportRequest(many, prefs, COVERED, "").options).toMatchObject({
      cover: true,
      cover_project: "Falcon",
      cover_background: "upload",
    })
    const body = reportRequest(many, prefs, COVERED, "", {
      title: "Q4",
      subtitle: "",
    })
    expect(body.options).toMatchObject({
      cover_title: "Q4",
      cover_subtitle: "",
    })
    // Untouched, the subtitle is the server's to generate.
    expect(
      reportRequest(many, prefs, COVERED, "").options?.cover_subtitle
    ).toBeUndefined()
  })

  it("offers the upload only when there is one", () => {
    expect(coverBackgroundItems(COVERED).map((i) => i.label)).toEqual([
      "Default",
      "Plain colour",
      "Your upload",
      "None",
    ])
    expect(
      coverBackgroundItems({
        ...COVERED,
        cover: { project: "Acme", upload: false, background: "waves" },
      }).map((i) => i.label)
    ).toEqual(["Default", "Plain colour", "None"])
    expect(
      coverBackgroundItems({
        ...COVERED,
        cover: { project: "Acme", upload: true, background: "upload" },
      }).map((i) => i.label)
    ).toEqual(["Default", "Waves", "Plain colour", "None"])
    // A remembered upload that is gone falls back to the default.
    const prefs = initialPrefs(
      {
        ...COVERED,
        cover: { project: "A", upload: false, background: "waves" },
      },
      { cover: true, coverBackground: "upload" }
    )
    expect(prefs.coverBackground).toBe("default")
    expect(prefs.cover).toBe(true)
  })

  it("generates the subtitle from the count and grouping", () => {
    const prefs = { ...initialPrefs(SCHEMA, null), groupBy: "site" }
    expect(coverSubtitle(many, prefs, SCHEMA)).toBe("3 devices · Group by Site")
    expect(coverSubtitle({ ids: ["d1"], scope: "one" }, prefs, SCHEMA)).toBe(
      "Device"
    )
  })

  it("is a tick that is remembered per type", async () => {
    apiMock.mockImplementation((path, init) => {
      if (path.includes("estimate=1")) return answerEstimate(init)
      if (init?.method === "POST") {
        posted.push({
          path,
          body: JSON.parse(String(init.body)) as ObjectReportRequest,
        })
        return Promise.resolve({ url: "/api/devices/report/file/tok/" })
      }
      return get(path, COVERED)
    })
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    const box = await screen.findByRole("checkbox", {
      name: "Include cover page",
    })
    expect(screen.queryByText("Cover title")).toBeNull()
    fireEvent.click(box)
    expect(screen.getByText("Cover title")).toBeTruthy()
    expect(screen.getByDisplayValue("3 devices")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Your upload" }))
    fireEvent.click(downloadButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.options).toMatchObject({
      cover: true,
      cover_background: "upload",
    })
    expect(readReportPrefs("device")).toMatchObject({
      cover: true,
      coverBackground: "upload",
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
      return get(path)
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

describe("sensitivity label", () => {
  const CONF: SensitivityLabelRef = {
    id: "l-conf",
    numid: 3,
    name: "Confidential",
    slug: "confidential",
    color: "#d97706",
    text_color: "#fff",
    icon: "shield",
    is_default: false,
  }
  const INTERNAL: SensitivityLabelRef = {
    ...CONF,
    id: "l-int",
    name: "Internal",
    slug: "internal",
    color: "#2563eb",
    icon: "building-2",
    is_default: true,
  }

  it("starts on the remembered pick, else the tenant's default, else none", () => {
    expect(initialPrefs(SCHEMA, null, []).sensitivityLabel).toBeNull()
    expect(initialPrefs(SCHEMA, null, [CONF, INTERNAL]).sensitivityLabel).toBe(
      "l-int"
    )
    expect(
      initialPrefs(SCHEMA, { sensitivityLabel: "l-conf" }, [CONF, INTERNAL])
        .sensitivityLabel
    ).toBe("l-conf")
    // None picked on purpose stays none.
    expect(
      initialPrefs(SCHEMA, { sensitivityLabel: null }, [CONF, INTERNAL])
        .sensitivityLabel
    ).toBeNull()
    // A remembered label that is gone falls back to the default.
    expect(
      initialPrefs(SCHEMA, { sensitivityLabel: "gone" }, [CONF, INTERNAL])
        .sensitivityLabel
    ).toBe("l-int")
  })

  it("sends the label only when one is picked", () => {
    const prefs = initialPrefs(SCHEMA, null, [])
    expect(
      reportRequest(many, prefs, SCHEMA, "").options?.sensitivity_label
    ).toBeUndefined()
    expect(
      reportRequest(many, { ...prefs, sensitivityLabel: "l-conf" }, SCHEMA, "")
        .options?.sensitivity_label
    ).toBe("l-conf")
  })

  it("is a picker of coloured pills, defaulted, posted and remembered", async () => {
    labels = [CONF, INTERNAL]
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    const trigger = await screen.findByRole("combobox", {
      name: "Sensitivity label",
    })
    // The tenant's default, as its badge with its icon.
    const badge = trigger.querySelector('[data-slot="badge"]')
    expect(badge?.textContent).toBe("Internal")
    expect(badge?.querySelector("svg")).not.toBeNull()
    fireEvent.click(trigger)
    const option = await screen.findByRole("option", { name: "Confidential" })
    expect(option.querySelector('[data-slot="badge"] svg')).not.toBeNull()
    fireEvent.click(option)
    fireEvent.click(downloadButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.options?.sensitivity_label).toBe("l-conf")
    expect(readReportPrefs("device")).toMatchObject({
      sensitivityLabel: "l-conf",
    })
  })

  it("is hidden when the reader has no labels", async () => {
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
    await screen.findByRole("checkbox", { name: "Include cover page" })
    expect(screen.queryByText("Sensitivity label")).toBeNull()
  })
})

describe("cover colours", () => {
  const COVERED: ObjectReportSchema = {
    ...SCHEMA,
    cover: { project: "Acme", upload: false, background: "waves" },
  }

  function openDialog() {
    apiMock.mockImplementation((path, init) => {
      if (path.includes("estimate=1")) return answerEstimate(init)
      if (init?.method === "POST") {
        posted.push({
          path,
          body: JSON.parse(String(init.body)) as ObjectReportRequest,
        })
        return Promise.resolve({ url: "/api/devices/report/file/tok/" })
      }
      return get(path, COVERED)
    })
    wrap(
      <ObjectReportDialog
        kind="device"
        target={many}
        open
        onOpenChange={() => {}}
      />
    )
  }

  async function tickCover() {
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "Include cover page" })
    )
  }

  it("sends the colours only when overridden", () => {
    const prefs = { ...initialPrefs(COVERED, null), cover: true }
    expect(
      reportRequest(many, prefs, COVERED, "").options?.cover_colors
    ).toBeUndefined()
    const green = { horizon: "#14532d", wave: "#16a34a", crest: "#ffffff" }
    expect(
      reportRequest(many, prefs, COVERED, "", undefined, green).options
        ?.cover_colors
    ).toEqual(green)
  })

  it("picks a preset for this report, or the tenant default", async () => {
    openDialog()
    await tickCover()
    const tenant = screen.getByRole("button", { name: "Tenant default" })
    expect(tenant.getAttribute("aria-pressed")).toBe("true")
    const danbyte = screen.getByRole("button", { name: "Danbyte" })
    fireEvent.click(danbyte)
    expect(danbyte.getAttribute("aria-pressed")).toBe("true")
    expect(tenant.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(downloadButton())
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0].body.options?.cover_colors).toEqual({
      horizon: "#063d66",
      wave: "#0b6fb0",
      crest: "#ffffff",
    })
  })

  it("hides the colours on a background not drawn in them", async () => {
    openDialog()
    await tickCover()
    expect(screen.getByText("Cover colours")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "None" }))
    expect(screen.queryByText("Cover colours")).toBeNull()
  })

  it("links tenant admins to the cover settings", async () => {
    openDialog()
    await tickCover()
    expect(screen.queryByText("Change cover colours…")).toBeNull()
    cleanup()
    me = { ...me, can_manage_users: true }
    openDialog()
    await tickCover()
    const link = await screen.findByText("Change cover colours…")
    expect(link.getAttribute("href")).toBe("/settings/tenant#report-cover")
  })
})
