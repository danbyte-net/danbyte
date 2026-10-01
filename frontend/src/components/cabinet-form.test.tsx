// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { Cabinet, CabinetTypeOption, CabinetWritePayload } from "@/lib/api"
import { CabinetForm } from "./cabinet-form"
import type { CabinetFormProps } from "./cabinet-form"
import { mm, mmOrNull } from "./cabinet-size-fields"

// Picking a cabinet type copies its plate and box sizes into the form; every
// size stays editable and the cabinet is the source of truth, so what is in
// the fields is what is sent. A new cabinet starts on the status flagged
// default for cabinets.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))
// The write goes through useSaveObject, which reads the location for plan
// mode; outside a plan it is a plain POST/PATCH.
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
  useRouterState: (opts: {
    select: (s: { location: { search: object } }) => unknown
  }) => opts.select({ location: { search: {} } }),
}))
vi.mock("@/components/custom-field-inputs", () => ({
  CustomFieldInputs: () => null,
}))

// jsdom implements none of these, and the popover/command/select primitives
// behind the pickers probe them.
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
Element.prototype.hasPointerCapture = () => false

const RITTAL: CabinetTypeOption = {
  id: "t1",
  numid: 1,
  name: "AE 1060.500",
  manufacturer: { id: "m1", name: "Rittal" },
  inner_width_mm: 525,
  inner_height_mm: 650,
  outer_width_mm: 600,
  outer_height_mm: 700,
  outer_depth_mm: 210,
}
// A type that only knows its plate.
const WALL_BOX: CabinetTypeOption = {
  id: "t2",
  numid: 2,
  name: "Wall box",
  manufacturer: null,
  inner_width_mm: 250,
  inner_height_mm: 300,
  outer_width_mm: null,
  outer_height_mm: null,
  outer_depth_mm: null,
}

const status = (id: string, name: string, defaultFor: string[]) => ({
  id,
  name,
  slug: name.toLowerCase(),
  color: "#10b981",
  text_color: "#ffffff",
  available_to: ["rack", "cabinet"],
  default_for: defaultFor,
})
const STATUSES = [
  status("st-planned", "Planned", []),
  status("st-active", "Active", ["rack", "cabinet"]),
]

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({
        id: "c-new",
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/sites/") return page([{ id: "s1", name: "HQ" }])
    if (path === "/api/cabinet-types/?picker=1") return page([RITTAL, WALL_BOX])
    if (path === "/api/cabinet-roles/?picker=1")
      return page([
        {
          id: "r1",
          numid: 1,
          name: "Distribution",
          slug: "distribution",
          color: "#2563eb",
        },
      ])
    if (path === "/api/statuses/?available_to=cabinet&picker=1")
      return page(STATUSES)
    return page([])
  })
})
afterEach(cleanup)

function renderForm(props: Partial<CabinetFormProps> = {}) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <CabinetForm onSaved={onSaved} onCancel={() => {}} {...props} />
    </QueryClientProvider>
  )
  return { onSaved }
}

/** The field a form label heads - Field draws the label above its control. */
function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}
const box = (label: string) =>
  within(field(label)).getByRole<HTMLInputElement>("spinbutton")
const SIZE_LABELS = [
  "Plate width (mm)",
  "Plate height (mm)",
  "Outer width (mm)",
  "Outer height (mm)",
  "Outer depth (mm)",
]
const sizes = () => SIZE_LABELS.map((l) => box(l).value)

/** Open a picker and choose an option once its list has loaded. */
async function pick(label: string, option: string) {
  fireEvent.click(within(field(label)).getByRole("combobox"))
  fireEvent.click(await screen.findByText(option))
}

function submit() {
  const form = screen.getByRole("button", { name: /Create cabinet|Save/ })
  fireEvent.submit(form.closest("form") as HTMLFormElement)
}

/** The body of the one write the form sent. */
function sent(): CabinetWritePayload & Record<string, unknown> {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as CabinetWritePayload &
    Record<string, unknown>
}

describe("CabinetForm sizes", () => {
  it("fills every size from the picked type", async () => {
    renderForm()
    expect(sizes()).toEqual(["", "", "", "", ""])
    await pick("Cabinet type", "Rittal AE 1060.500")
    expect(sizes()).toEqual(["525", "650", "600", "700", "210"])
  })

  it("clears the box sizes for a type that doesn't give them", async () => {
    renderForm()
    await pick("Cabinet type", "Rittal AE 1060.500")
    await pick("Cabinet type", "Wall box")
    expect(sizes()).toEqual(["250", "300", "", "", ""])
  })

  it("sends the filled sizes, edits included, with the type", async () => {
    const { onSaved } = renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: " K1 " },
    })
    await pick("Site", "HQ")
    await pick("Cabinet type", "Rittal AE 1060.500")
    // Still editable after the prefill - the cabinet is the source of truth.
    fireEvent.change(box("Outer depth (mm)"), { target: { value: "250" } })
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls.find(
      ([, i]) => i?.method === "POST"
    )!
    expect(path).toBe("/api/cabinets/")
    expect(init?.method).toBe("POST")
    expect(sent()).toMatchObject({
      name: "K1",
      site_id: "s1",
      cabinet_type_id: "t1",
      inner_width_mm: 525,
      inner_height_mm: 650,
      outer_width_mm: 600,
      outer_height_mm: 700,
      outer_depth_mm: 250,
    })
  })

  it("leaves a blank plate out, so the server copies the type's", async () => {
    const { onSaved } = renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "K2" },
    })
    await pick("Site", "HQ")
    await pick("Cabinet type", "Wall box")
    fireEvent.change(box("Plate width (mm)"), { target: { value: "" } })
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const body = sent()
    expect("inner_width_mm" in body).toBe(false)
    expect(body.inner_height_mm).toBe(300)
    // A blank box side is sent as cleared.
    expect(body.outer_width_mm).toBeNull()
  })

  it("pre-fills from the type it was opened with, once the types load", async () => {
    renderForm({ initialCabinetTypeId: "t1" })
    await waitFor(() =>
      expect(sizes()).toEqual(["525", "650", "600", "700", "210"])
    )
    expect(
      within(field("Cabinet type")).getByRole("combobox").textContent
    ).toContain("Rittal AE 1060.500")
  })

  it("keeps an edited cabinet's own sizes", async () => {
    const cabinet: Cabinet = {
      id: "c1",
      numid: 1,
      name: "K1",
      facility_id: "",
      site: { id: "s1", name: "HQ" },
      location: null,
      role: null,
      cabinet_type: RITTAL,
      status: null,
      inner_width_mm: 500,
      inner_height_mm: 600,
      outer_width_mm: null,
      outer_height_mm: null,
      outer_depth_mm: null,
      description: "",
      document_count: 0,
      tags: [],
      custom_fields: {},
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    }
    renderForm({ cabinet })
    expect(sizes()).toEqual(["500", "600", "", "", ""])
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/statuses/?available_to=cabinet&picker=1"
      )
    )
    // An edit never takes the default status, nor the type's sizes unasked.
    await new Promise((r) => setTimeout(r, 0))
    expect(sizes()).toEqual(["500", "600", "", "", ""])
    expect(
      within(field("Status")).getByRole("combobox").textContent
    ).not.toContain("Active")
  })
})

describe("CabinetForm status", () => {
  it("starts a new cabinet on the status flagged default for cabinets", async () => {
    renderForm()
    const trigger = () => within(field("Status")).getByRole("combobox")
    await waitFor(() => expect(trigger().textContent).toContain("Active"))
    // The selected value is the status pill, not a dot beside a name.
    expect(
      within(trigger()).getByText("Active").getAttribute("data-slot")
    ).toBe("badge")
  })
})

describe("size values", () => {
  it("leaves a blank required size out and clears a blank optional one", () => {
    expect(mm("")).toBeUndefined()
    expect(mm(" 525 ")).toBe(525)
    expect(mmOrNull("")).toBeNull()
    expect(mmOrNull("210")).toBe(210)
  })
})
