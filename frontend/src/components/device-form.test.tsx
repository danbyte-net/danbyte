// @vitest-environment jsdom
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type {
  Cabinet,
  Device,
  DeviceTypeOption,
  DeviceWritePayload,
  RackOption,
} from "@/lib/api"
import { DeviceForm } from "./device-form"
import type { DeviceFormProps } from "./device-form"

// A device sits in a rack or in a cabinet (#277). The form's Mounting
// section offers both, behind Rack | Cabinet tabs; picking one clears the
// other, and a rail sent without an offset lets the server take the first
// gap the device fits in.

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
vi.mock("@/components/monitoring-engine-field", () => ({
  MonitoringEngineField: () => null,
}))
vi.mock("@/components/topology/diagram/card-lines-dialog", () => ({
  CardLinesEditor: () => null,
  useCardLineConfig: () => ({ data: undefined }),
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

const PLC: DeviceTypeOption = {
  id: "t1",
  name: "PLC",
  manufacturer: null,
  manufacturer_id: null,
  u_height: 0,
  rack_width: "full",
  is_full_depth: false,
  width_mm: 60,
  height_mm: 147,
  din_profiles: ["ts35"],
  din_rail_mm: null,
  front_image: null,
  rear_image: null,
}

const K1: Cabinet = {
  id: "c1",
  numid: 1,
  name: "K1",
  facility_id: "",
  site: { id: "s1", name: "Plant" },
  location: null,
  role: null,
  cabinet_type: null,
  status: null,
  inner_width_mm: 525,
  inner_height_mm: 625,
  outer_width_mm: null,
  outer_height_mm: null,
  outer_depth_mm: null,
  rails: [
    {
      id: "r1",
      label: "R1",
      profile: "ts35",
      x_mm: 0,
      y_mm: 75,
      length_mm: 525,
    },
    {
      id: "r2",
      label: "R2",
      profile: "ts15",
      x_mm: 0,
      y_mm: 200,
      length_mm: 300,
    },
  ],
  description: "",
  document_count: 0,
  device_count: 3,
  tags: [],
  custom_fields: {},
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}

const RACK: RackOption = {
  id: "rk1",
  name: "R-01",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
}

/** A device on R1 at `offset`, as /api/devices/?din_rail= lists it. */
const onR1 = (id: string, offset: number, width = 60) =>
  ({
    id,
    name: id,
    din_offset_mm: offset,
    din_rail: { id: "r1", label: "R1", profile: "ts35" },
    cabinet: { id: "c1", name: "K1" },
    device_type: { ...PLC, width_mm: width },
  }) as unknown as Device

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

let refuse: Record<string, string[]> | null = null

beforeEach(() => {
  refuse = null
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (refuse && (init?.method === "POST" || init?.method === "PATCH"))
      return Promise.reject(new ApiError(400, refuse))
    if (init?.method === "POST" || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as DeviceWritePayload
      return Promise.resolve({
        id: "d-new",
        ...body,
        cabinet: body.cabinet_id ? { id: body.cabinet_id, name: "K1" } : null,
      })
    }
    if (path === "/api/device-types/?picker=1") return page([PLC])
    if (path === "/api/sites/") return page([{ id: "s1", name: "Plant" }])
    if (path === "/api/racks/?picker=1") return page([RACK])
    if (path.startsWith("/api/cabinets/?picker=1"))
      return page([
        {
          id: "c1",
          numid: 1,
          name: "K1",
          site: { id: "s1", name: "Plant" },
        },
      ])
    if (path === "/api/cabinets/c1/") return Promise.resolve(K1)
    if (path === "/api/devices/?din_rail=r1&page_size=500")
      return page([onR1("a", 0), onR1("self", 60), onR1("b", 300, 45)])
    if (path === "/api/device-fields/")
      return Promise.resolve({ comments: true, location: true })
    return page([])
  })
})
afterEach(cleanup)
// The device form is a big one - every picker, popover and section - and
// jsdom takes its time over it when the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5000 })

function renderForm(props: Partial<DeviceFormProps> = {}) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <DeviceForm onSaved={onSaved} onCancel={() => {}} {...props} />
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
const trigger = (label: string) => within(field(label)).getByRole("combobox")

/** Open a picker and choose an option once its list has loaded. */
async function pick(label: string, option: string | RegExp) {
  fireEvent.click(trigger(label))
  fireEvent.click(await screen.findByRole("option", { name: option }))
}

const tab = (name: "Rack" | "Cabinet") =>
  fireEvent.click(screen.getByRole("button", { name }))

async function save(name = "plc-1") {
  fireEvent.change(within(field("Name")).getByRole("textbox"), {
    target: { value: name },
  })
  const submit = screen.getByRole("button", { name: "Create device" })
  fireEvent.submit(submit.closest("form") as HTMLFormElement)
}

/** The body of the one write the form sent. */
async function sent(): Promise<DeviceWritePayload> {
  await waitFor(() =>
    expect(apiMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
      true
    )
  )
  const call = apiMock.mock.calls.find(([, init]) => init?.method === "POST")!
  return JSON.parse(String(call[1]?.body)) as DeviceWritePayload
}

describe("DeviceForm mounting", () => {
  it("clears the rack when a cabinet is picked, and fills the site", async () => {
    renderForm({ initial: { rackId: "rk1", position: 10, face: "front" } })
    await waitFor(() => expect(trigger("Rack").textContent).toContain("R-01"))

    tab("Cabinet")
    await pick("Cabinet", /K1/)
    await waitFor(() =>
      expect(trigger("Rail").hasAttribute("disabled")).toBe(false)
    )
    tab("Rack")
    expect(trigger("Rack").textContent).toContain("Select a rack…")

    await save()
    expect(await sent()).toMatchObject({
      rack_id: null,
      position: null,
      face: "",
      cabinet_id: "c1",
      din_rail_id: null,
      din_offset_mm: null,
      // A device in a cabinet is at the cabinet's site.
      site_id: "s1",
    })
  })

  it("clears the cabinet when a rack is picked", async () => {
    renderForm({ initial: { cabinetId: "c1", dinRailId: "r1" } })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))

    tab("Rack")
    await pick("Rack", "R-01")
    tab("Cabinet")
    expect(trigger("Cabinet").textContent).toContain("Select a cabinet…")

    await save()
    expect(await sent()).toMatchObject({
      rack_id: "rk1",
      cabinet_id: null,
      din_rail_id: null,
      din_offset_mm: null,
    })
  })

  it("sends the rail with no offset when the offset is blank", async () => {
    const { onSaved } = renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1" },
    })
    // Opened from a rail: the Cabinet tab, with the cabinet and rail picked.
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))
    expect(trigger("Cabinet").textContent).toContain("K1")
    expect(
      within(field("Offset (mm)")).getByRole<HTMLInputElement>("spinbutton")
        .value
    ).toBe("")

    await save()
    const body = await sent()
    expect(body).toMatchObject({
      cabinet_id: "c1",
      din_rail_id: "r1",
      rack_id: null,
      site_id: "s1",
    })
    // Sent, and empty: the server takes the first gap that fits.
    expect(body.din_offset_mm).toBeNull()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
  })

  it("sends a typed offset with the rail", async () => {
    renderForm({ initial: { cabinetId: "c1", dinRailId: "r1" } })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "120.5" },
    })
    await save()
    expect(await sent()).toMatchObject({
      din_rail_id: "r1",
      din_offset_mm: 120.5,
    })
  })

  it("brings up the Cabinet tab when the server refuses its rail", async () => {
    refuse = { din_rail_id: ["No gap on R1 is 60 mm wide."] }
    renderForm({ initial: { cabinetId: "c1", dinRailId: "r1" } })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))
    tab("Rack")
    await save()
    const message = await screen.findByText("No gap on R1 is 60 mm wide.")
    expect(field("Rail").contains(message)).toBe(true)
  })

  it("offers the cabinet's rails, those of another profile disabled", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await waitFor(() =>
      expect(trigger("Rail").hasAttribute("disabled")).toBe(false)
    )
    fireEvent.click(trigger("Rail"))
    const r1 = await screen.findByRole("option", { name: /R1/ })
    const r2 = screen.getByRole("option", { name: /R2/ })
    expect(r1.textContent).toContain("TS 35")
    expect(r1.getAttribute("aria-disabled")).not.toBe("true")
    // The PLC mounts on TS 35 only.
    expect(r2.textContent).toContain("TS 15")
    expect(r2.getAttribute("aria-disabled")).toBe("true")
  })

  it("lists the rail's free gaps, the device's own span left out", async () => {
    const device = {
      ...onR1("self", 60),
      site: { id: "s1", name: "Plant" },
      rack: null,
      position: null,
      face: "",
      rack_side: "",
      mount: "",
      mount_offset_mm: null,
      mount_span_u: null,
      tags: [],
      custom_fields: {},
    } as unknown as Device
    renderForm({ device })
    expect(await screen.findByText("Free 60-300, 345-525 mm")).toBeTruthy()
    expect(
      within(field("Offset (mm)")).getByRole<HTMLInputElement>("spinbutton")
        .value
    ).toBe("60")
  })
})
