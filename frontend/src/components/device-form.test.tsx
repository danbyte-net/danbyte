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
  Rack,
  RackOption,
} from "@/lib/api"
import { DeviceForm } from "./device-form"
import type { DeviceFormProps } from "./device-form"

// A device sits in a rack or in a cabinet (#277). The form's Mounting
// section offers both, behind Rack | Cabinet tabs; picking one clears the
// other, and a rail sent without an offset lets the server take the first
// gap the device fits in. Under the fields each tab draws what the device
// goes into - the cabinet's plate, the rack's two faces - and a click there
// places it.

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
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
// jsdom lays nothing out: take a pointer's screen pixels to be the plate's
// millimetres, so a click at (150, 75) lands 150 mm across, 75 mm down.
class PointStub {
  x: number
  y: number
  constructor(x = 0, y = 0) {
    this.x = x
    this.y = y
  }
  matrixTransform() {
    return { x: this.x, y: this.y }
  }
}
;(globalThis as unknown as Record<string, unknown>).DOMPoint = PointStub
;(
  SVGElement.prototype as unknown as { getScreenCTM: () => unknown }
).getScreenCTM = () => ({ inverse: () => ({}) })

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
    {
      id: "r3",
      label: "R3",
      profile: "ts35",
      x_mm: 0,
      y_mm: 400,
      length_mm: 200,
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

/** A 2U server: full width, not on DIN rails. */
const SRV: DeviceTypeOption = {
  ...PLC,
  id: "t2",
  name: "SRV",
  u_height: 2,
  is_full_depth: true,
  width_mm: null,
  height_mm: null,
  din_profiles: [],
}

const RACK: RackOption = {
  id: "rk1",
  name: "R-01",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
}

/** The rack itself, as its page and the form's elevation read it. */
const RACK_DETAIL = {
  ...RACK,
  numid: 1,
  facility_id: "",
  site: { id: "s1", name: "Plant" },
  role: null,
  rack_type: null,
  status: null,
  location: null,
  width: 19,
  used_units: 1,
  device_count: 1,
} as unknown as Rack

/** A 1U device in the rack at `position`, front-mounted. */
const inRack = (id: string, position: number) =>
  ({
    id,
    name: id,
    position,
    face: "front",
    rack_side: "",
    rack_width: "full",
    mount: "",
    u_height: 1,
    role: null,
    device_type: { ...SRV, u_height: 1 },
    rack: { id: "rk1", name: "R-01" },
  }) as unknown as Device

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
/** What /api/devices/?cabinet=c1 and ?rack=rk1 list. */
let cabinetDevices: Device[] = []
let rackDevices: Device[] = []

beforeEach(() => {
  refuse = null
  cabinetDevices = [onR1("a", 0), onR1("self", 60), onR1("b", 300, 45)]
  rackDevices = [inRack("sw-a", 10)]
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
    if (path === "/api/device-types/?picker=1") return page([PLC, SRV])
    if (path === "/api/sites/") return page([{ id: "s1", name: "Plant" }])
    if (path === "/api/racks/?picker=1") return page([RACK])
    if (path === "/api/racks/rk1/") return Promise.resolve(RACK_DETAIL)
    if (path === "/api/devices/?rack=rk1") return page(rackDevices)
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
    if (path === "/api/devices/?cabinet=c1&page_size=500")
      return page(cabinetDevices)
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

/** Open a select and choose one of its options. */
async function choose(label: string, option: string) {
  fireEvent.pointerDown(trigger(label), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  })
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
    // Its own offset, kept once the type and the rail's devices are in -
    // not the first free gap.
    await typed()
    expect(
      within(field("Offset (mm)")).getByRole<HTMLInputElement>("spinbutton")
        .value
    ).toBe("60")
    // On the plate it is the outline, at its offset - not a device beside it.
    expect(document.querySelector('[data-device="self"]')).toBeNull()
    expect(document.querySelector('[data-device="a"]')).not.toBeNull()
    expect(outline()).toMatchObject({ rail: "R1", x: 60, clash: false })
  })
})

/** The plate's press target, once the cabinet and its devices are in. */
async function plate(): Promise<Element> {
  return waitFor(() => {
    const el = document.querySelector('[data-part="target"]')
    if (!el) throw new Error("no plate yet")
    return el
  })
}

/** Wait for the PLC's type to have come in: R2, a TS 15 rail, goes faint. */
async function typed() {
  await waitFor(() =>
    expect(
      document.querySelector('[data-rail="R2"]')?.getAttribute("data-dimmed")
    ).toBe("true")
  )
}

/** The device's outline on the plate: its rail, where its body is drawn
 * and whether it is red; null while there is none. */
function outline() {
  const g = document.querySelector('[data-part="placement"]')
  const body = g?.querySelector('[data-part="body"]')
  if (!g || !body) return null
  return {
    rail: g.getAttribute("data-rail"),
    x: Number(body.getAttribute("x")),
    width: Number(body.getAttribute("width")),
    clash: g.hasAttribute("data-clash"),
    provisional: g.hasAttribute("data-provisional"),
  }
}

const offsetValue = () =>
  within(field("Offset (mm)")).getByRole<HTMLInputElement>("spinbutton").value
const status = () =>
  document.querySelector('[data-part="status"]')?.textContent ?? ""

describe("DeviceForm cabinet plate", () => {
  // K1's R1 is a TS 35 rail along the top, 525 mm; a 60 mm device at 0
  // ("a"), one at 60 ("self") and a 45 mm one at 300 ("b") leave 120-300
  // and 345-525 free. R2 is TS 15, which the PLC does not mount on.

  it("puts the device where a rail is clicked, and sends that spot", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    // 150 mm along R1, in the free stretch 120-300.
    fireEvent.click(await plate(), { clientX: 150, clientY: 75 })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))
    expect(offsetValue()).toBe("150")
    expect(outline()).toMatchObject({ rail: "R1", x: 150, width: 60 })

    await save()
    expect(await sent()).toMatchObject({
      cabinet_id: "c1",
      din_rail_id: "r1",
      din_offset_mm: 150,
      rack_id: null,
    })
  })

  it("snaps it flush against a neighbour, and fits it to the gap", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    // 4 mm right of "self", which ends at 120.
    fireEvent.click(await plate(), { clientX: 124, clientY: 75 })
    await waitFor(() => expect(offsetValue()).toBe("120"))
    // Clicked at 280, 60 mm wide: it would run into "b" at 300, so it
    // moves left until it ends there.
    fireEvent.click(await plate(), { clientX: 280, clientY: 75 })
    await waitFor(() => expect(offsetValue()).toBe("240"))
    expect(outline()).toMatchObject({ x: 240, clash: false })
  })

  it("refuses a gap too narrow for it, and says why", async () => {
    // A 120 mm device at 150 leaves 30 mm on each side of it.
    cabinetDevices.push(onR1("c", 150, 120))
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    const target = await plate()
    fireEvent.pointerMove(target, { clientX: 130, clientY: 75 })
    expect(
      document.querySelector('[data-part="ghost"]')?.hasAttribute("data-bad")
    ).toBe(true)
    expect(status()).toBe("Only 30 mm free here")

    fireEvent.click(target, { clientX: 130, clientY: 75 })
    expect(status()).toBe("Only 30 mm free here")
    expect(trigger("Rail").textContent).toContain("Pick a rail…")
    expect(offsetValue()).toBe("")
    expect(outline()).toBeNull()
    // On a device there is no gap at all.
    fireEvent.click(target, { clientX: 200, clientY: 75 })
    expect(status()).toBe("Taken by c")
  })

  it("moves the outline as the offset is typed, red where the server would refuse it", async () => {
    renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1", deviceTypeId: "t1" },
    })
    await typed()
    const input = within(field("Offset (mm)")).getByRole("spinbutton")
    fireEvent.change(input, { target: { value: "200" } })
    await waitFor(() => expect(outline()).toMatchObject({ x: 200 }))
    expect(outline()?.clash).toBe(false)

    // 320-380 runs over "b" at 300-345.
    fireEvent.change(input, { target: { value: "320" } })
    await waitFor(() => expect(outline()).toMatchObject({ x: 320 }))
    expect(outline()?.clash).toBe(true)
    expect(status()).toBe("Overlaps b at 300-345 mm.")
    const red = document.querySelector('[data-part="clash"]')
    expect([red?.getAttribute("x"), red?.getAttribute("width")]).toEqual([
      "320",
      "25",
    ])

    fireEvent.change(input, { target: { value: "480" } })
    await waitFor(() =>
      expect(status()).toBe("Runs past the rail's end (525 mm).")
    )
  })

  it("fills the offset with the first gap the device fits when a rail is picked", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    await pick("Rail", /R1/)
    // 0-120 is taken; 120-300 holds the 60 mm PLC.
    await waitFor(() => expect(offsetValue()).toBe("120"))
    expect(outline()).toMatchObject({ rail: "R1", x: 120, provisional: false })

    // The offset was R1's: another rail fills its own.
    await pick("Rail", /R3/)
    await waitFor(() => expect(offsetValue()).toBe("0"))
    expect(outline()).toMatchObject({ rail: "R3", x: 0 })

    // Cleared, it stays blank - the server takes the first gap - and the
    // outline shows where that is.
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "" },
    })
    await waitFor(() => expect(outline()?.provisional).toBe(true))
    expect(offsetValue()).toBe("")
    await save()
    const body = await sent()
    expect(body.din_rail_id).toBe("r3")
    expect(body.din_offset_mm).toBeNull()
  })

  it("fills it for the rail the form is opened on, and sends it", async () => {
    renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1", deviceTypeId: "t1" },
    })
    await waitFor(() => expect(offsetValue()).toBe("120"))
    await save()
    expect(await sent()).toMatchObject({
      din_rail_id: "r1",
      din_offset_mm: 120,
    })
  })

  it("keeps the offset it is opened with - Add device here on the plate", async () => {
    renderForm({
      initial: {
        cabinetId: "c1",
        dinRailId: "r1",
        dinOffset: 200,
        deviceTypeId: "t1",
      },
    })
    await typed()
    await waitFor(() => expect(outline()).toMatchObject({ x: 200 }))
    expect(offsetValue()).toBe("200")
  })

  it("keeps a typed offset when the first rail is picked after it", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "200" },
    })
    await pick("Rail", /R1/)
    await waitFor(() => expect(outline()).toMatchObject({ x: 200 }))
    expect(offsetValue()).toBe("200")
  })

  it("leaves the offset blank where no gap fits, and says so", async () => {
    // R1 taken to 500 of its 525 mm: 25 mm left for a 60 mm device.
    cabinetDevices = [onR1("big", 0, 500)]
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    await pick("Rail", /R1/)
    await waitFor(() => expect(status()).toBe("No gap fits"))
    expect(offsetValue()).toBe("")
    expect(outline()).toBeNull()
    expect(
      document.querySelector('[data-rail="R1"]')?.getAttribute("data-invalid")
    ).toBe("true")

    // Another rail tries again.
    await pick("Rail", /R3/)
    await waitFor(() => expect(offsetValue()).toBe("0"))
    expect(
      document.querySelector('[data-rail="R1"]')?.hasAttribute("data-invalid")
    ).toBe(false)
  })

  it("centres the device in a free gap that is double-clicked", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    // 120-300 is 180 mm: a 60 mm device centred in it sits at 180.
    fireEvent.doubleClick(await plate(), { clientX: 200, clientY: 75 })
    await waitFor(() => expect(offsetValue()).toBe("180"))
    expect(trigger("Rail").textContent).toContain("R1")
  })

  it("draws rails of another profile faint, and they take no clicks", async () => {
    renderForm({ initial: { cabinetId: "c1", deviceTypeId: "t1" } })
    await typed()
    expect(
      document.querySelector('[data-rail="R1"]')?.hasAttribute("data-dimmed")
    ).toBe(false)
    fireEvent.click(await plate(), { clientX: 100, clientY: 200 })
    expect(status()).toBe("PLC does not mount on a TS 15 rail.")
    expect(trigger("Rail").textContent).toContain("Pick a rail…")
  })

  it("nudges the focused outline with the arrow keys", async () => {
    renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1", deviceTypeId: "t1" },
    })
    await typed()
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "150" },
    })
    const slider = await screen.findByRole("slider", { name: "Device" })
    fireEvent.keyDown(slider, { key: "ArrowRight" })
    await waitFor(() => expect(offsetValue()).toBe("151"))
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(offsetValue()).toBe("161"))
    fireEvent.keyDown(slider, { key: "ArrowLeft" })
    await waitFor(() => expect(offsetValue()).toBe("160"))
    // Down past R2, a TS 15 rail, onto R3 - kept where it is across the
    // plate, as far as R3's 200 mm lets it: 140.
    fireEvent.keyDown(slider, { key: "ArrowDown" })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R3"))
    expect(offsetValue()).toBe("140")
    expect(outline()).toMatchObject({ rail: "R3", x: 140 })
    fireEvent.keyDown(screen.getByRole("slider", { name: "Device" }), {
      key: "ArrowUp",
    })
    await waitFor(() => expect(trigger("Rail").textContent).toContain("R1"))
    expect(offsetValue()).toBe("140")
  })

  it("drags the outline along the rail, and lets go flush against a neighbour it overlaps", async () => {
    renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1", deviceTypeId: "t1" },
    })
    await typed()
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "150" },
    })
    const slider = await screen.findByRole("slider", { name: "Device" })
    // Picked up 10 mm into its body.
    const at = (x: number) => ({ clientX: x, clientY: 75, pointerId: 1 })
    fireEvent.pointerDown(slider, { ...at(160), button: 0 })
    fireEvent.pointerMove(slider, at(200))
    expect(outline()).toMatchObject({ x: 190, clash: false })
    expect(status()).toBe("R1 · 190 mm")
    // 260-320 runs over "b": red while it does.
    fireEvent.pointerMove(slider, at(270))
    expect(outline()).toMatchObject({ x: 260, clash: true })
    expect(status()).toBe("Overlaps b at 300-345 mm.")
    // Let go there, it slides back into the gap until it touches "b".
    fireEvent.pointerUp(slider, at(270))
    await waitFor(() => expect(offsetValue()).toBe("240"))
    expect(outline()).toMatchObject({ x: 240, clash: false })
  })
})

describe("DeviceForm offset slider", () => {
  // Under the plate, the offset as a slider along R1: 525 mm, the 60 mm PLC
  // free in 120-300 and 345-525 beside "a", "self" and "b".

  /** The form on R1 with the offset typed in, and the slider's thumb. */
  async function onR1At(at: string) {
    renderForm({
      initial: { cabinetId: "c1", dinRailId: "r1", deviceTypeId: "t1" },
    })
    await typed()
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: at },
    })
    const thumb = await screen.findByRole("slider", { name: "Offset" })
    await waitFor(() => expect(thumb.getAttribute("aria-valuenow")).toBe(at))
    return thumb
  }
  const button = (name: string) =>
    screen.getByRole<HTMLButtonElement>("button", { name })

  it("runs from the rail's left end to its length less the device's width", async () => {
    const thumb = await onR1At("150")
    expect(thumb.getAttribute("aria-valuemin")).toBe("0")
    expect(thumb.getAttribute("aria-valuemax")).toBe("465")
    expect(thumb.getAttribute("aria-valuetext")).toBe("150–210 mm")
    // The edges read out beside the line.
    expect(document.querySelector('[data-part="edges"]')?.textContent).toBe(
      "150–210 mm"
    )
    // The rail's devices are muted stretches along the track.
    const taken = [...document.querySelectorAll('[data-part="taken"]')].map(
      (el) => (el as HTMLElement).style.left
    )
    expect(taken).toEqual([
      "0%",
      `${(60 / 525) * 100}%`,
      `${(300 / 525) * 100}%`,
    ])
  })

  it("steps a millimetre with the arrow keys, ten with Shift", async () => {
    const thumb = await onR1At("150")
    fireEvent.keyDown(thumb, { key: "ArrowRight" })
    await waitFor(() => expect(offsetValue()).toBe("151"))
    fireEvent.keyDown(thumb, { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(offsetValue()).toBe("161"))
    fireEvent.keyDown(thumb, { key: "ArrowLeft" })
    await waitFor(() => expect(offsetValue()).toBe("160"))
    // Home and End: the first and the last place it fits.
    fireEvent.keyDown(thumb, { key: "End" })
    await waitFor(() => expect(offsetValue()).toBe("465"))
    fireEvent.keyDown(thumb, { key: "Home" })
    await waitFor(() => expect(offsetValue()).toBe("120"))
    expect(outline()).toMatchObject({ x: 120 })
  })

  it("jumps between the gaps the device fits in", async () => {
    const thumb = await onR1At("150")
    expect(button("Previous gap").disabled).toBe(true)
    fireEvent.keyDown(thumb, { key: "PageUp" })
    await waitFor(() => expect(offsetValue()).toBe("345"))
    expect(button("Next gap").disabled).toBe(true)
    fireEvent.keyDown(thumb, { key: "PageDown" })
    await waitFor(() => expect(offsetValue()).toBe("120"))
    fireEvent.click(button("Next gap"))
    await waitFor(() => expect(offsetValue()).toBe("345"))
    fireEvent.click(button("Previous gap"))
    await waitFor(() => expect(offsetValue()).toBe("120"))
  })

  it("sets the device flush against either end of its gap", async () => {
    await onR1At("150")
    fireEvent.click(button("Flush right"))
    // Against "b" at 300.
    await waitFor(() => expect(offsetValue()).toBe("240"))
    expect(button("Flush right").disabled).toBe(true)
    fireEvent.click(button("Flush left"))
    // Against "self", which ends at 120.
    await waitFor(() => expect(offsetValue()).toBe("120"))
    expect(button("Flush left").disabled).toBe(true)
  })

  it("follows the offset as it is typed, red where it overlaps", async () => {
    const thumb = await onR1At("150")
    fireEvent.change(within(field("Offset (mm)")).getByRole("spinbutton"), {
      target: { value: "320" },
    })
    await waitFor(() => expect(thumb.getAttribute("aria-valuenow")).toBe("320"))
    expect(thumb.className).toContain("border-destructive")
    expect(outline()).toMatchObject({ x: 320, clash: true })
  })
})

/** A unit band of one face of the rack drawn under the fields. */
async function unit(face: "front" | "rear", u: number): Promise<Element> {
  return waitFor(() => {
    const el = document.querySelector(
      `[data-face="${face}"] [data-unit="${u}"]`
    )
    if (!el) throw new Error(`no ${face} U${u} yet`)
    return el
  })
}

/** Which faces the device's outline is drawn on. */
const outlinedFaces = () =>
  [...document.querySelectorAll('[data-part="placement"]')].map((el) =>
    el.closest("[data-face]")?.getAttribute("data-face")
  )

describe("DeviceForm rack elevation", () => {
  // R-01 is 42U, sw-a front-mounted at U10; the server is a 2U SRV.

  async function rackForm(initial: DeviceFormProps["initial"] = {}) {
    renderForm({ initial: { rackId: "rk1", deviceTypeId: "t2", ...initial } })
    await waitFor(() =>
      expect(trigger("Device type").textContent).toContain("SRV")
    )
    // sw-a drawn on the front face: the rack and its devices are in.
    await waitFor(() =>
      expect(
        document.querySelector('[data-face="front"] [data-device="sw-a"]')
      ).not.toBeNull()
    )
  }

  it("sets the position and face from a clicked unit, and sends them", async () => {
    await rackForm()
    fireEvent.click(await unit("rear", 20))
    await waitFor(() =>
      expect(trigger("Position (U)").textContent).toContain("U20–U21")
    )
    expect(trigger("Face").textContent).toContain("Rear")
    expect(outlinedFaces()).toEqual(["rear"])

    await save()
    expect(await sent()).toMatchObject({
      rack_id: "rk1",
      position: 20,
      face: "rear",
      cabinet_id: null,
    })
  })

  it("moves a device down to fit when it would run past the top", async () => {
    await rackForm()
    fireEvent.click(await unit("front", 42))
    await waitFor(() =>
      expect(trigger("Position (U)").textContent).toContain("U41–U42")
    )
    expect(trigger("Face").textContent).toContain("Front")
  })

  it("takes no click on a taken unit, and says whose it is", async () => {
    await rackForm()
    fireEvent.click(await unit("front", 10))
    expect(status()).toBe("Taken by sw-a")
    expect(trigger("Position (U)").textContent).toContain("Pick a unit…")
    // Both are full depth, so the rear of U10 is taken too (#375).
    fireEvent.click(await unit("rear", 10))
    expect(status()).toContain("sw-a")
    expect(trigger("Position (U)").textContent).toContain("Pick a unit…")
  })

  it("draws the outline red where it collides, in the server's words", async () => {
    await rackForm({ position: 9, face: "front" })
    await waitFor(() => expect(status()).toBe("Overlaps sw-a at U10."))
    const box = document.querySelector('[data-part="placement"]')
    expect(box?.hasAttribute("data-clash")).toBe(true)
    // U10 red, U9 not.
    expect(document.querySelectorAll('[data-part="clash"]')).toHaveLength(1)
  })

  it("moves the outline as a position is picked", async () => {
    await rackForm({ position: 20, face: "front" })
    expect(outlinedFaces()).toEqual(["front"])
    const row = () =>
      (document.querySelector('[data-part="placement"]') as HTMLElement).style
        .gridRow
    // 42U with the top unit first: U21 is row 22.
    expect(row()).toBe("22 / span 2")
    await pick("Position (U)", "U30–U31")
    await waitFor(() => expect(row()).toBe("12 / span 2"))
  })

  it("moves the outline to the face chosen", async () => {
    await rackForm({ position: 20, face: "front" })
    expect(outlinedFaces()).toEqual(["front"])
    await choose("Face", "Rear")
    await waitFor(() => expect(outlinedFaces()).toEqual(["rear"]))
    // No face: it collides on both, so it is drawn on both.
    await choose("Face", "-")
    await waitFor(() => expect(outlinedFaces()).toEqual(["front", "rear"]))
  })

  it("leaves a side-mounted strip off the units", async () => {
    // A 0U strip hung on the left rail has no position: nothing to draw.
    renderForm({ initial: { rackId: "rk1", deviceTypeId: "t1" } })
    await waitFor(() =>
      expect(trigger("Device type").textContent).toContain("PLC")
    )
    await unit("front", 20)
    await choose("Side mount (0U)", "Left rail")
    await waitFor(() =>
      expect(document.querySelector("[data-face]")).toBeNull()
    )
    await save()
    expect(await sent()).toMatchObject({
      rack_id: "rk1",
      mount: "side_left",
      position: null,
    })
  })
})

describe("DeviceForm side mount", () => {
  it("keeps a strip's side mount while the device types load", async () => {
    // Until the types answer, the strip's type is unknown - not "takes
    // units" - so its side mount must survive to the save.
    const PDU = { ...SRV, id: "t3", name: "PDU", u_height: 0 }
    let release: () => void = () => {}
    const typesLater = new Promise<void>((r) => {
      release = r
    })
    const base = apiMock.getMockImplementation()!
    apiMock.mockImplementation((path, init) =>
      path === "/api/device-types/?picker=1"
        ? typesLater.then(() => page([PDU]))
        : base(path, init)
    )
    const device = {
      ...inRack("pdu-a", 0),
      position: null,
      face: "rear",
      mount: "left",
      mount_offset_mm: 50,
      mount_span_u: 30,
      site: { id: "s1", name: "Plant" },
      cabinet: null,
      din_rail: null,
      din_offset_mm: null,
      device_type: PDU,
      status: null,
      role: null,
      platform: null,
      location: null,
      cluster: null,
      config_template: null,
      virtual_chassis: null,
      vc_position: null,
      vc_priority: null,
      serial_number: "",
      asset_tag: "",
      description: "",
      comments: "",
      airflow: "",
      latitude: null,
      longitude: null,
      topology_card: null,
      topology_photo_size: "",
      tags: [],
      custom_fields: {},
    } as unknown as Device
    renderForm({ device })
    await new Promise((r) => setTimeout(r, 50))
    release()
    await screen.findByText("Side mount (0U)")
    const submit = screen.getByRole("button", { name: "Save changes" })
    fireEvent.submit(submit.closest("form") as HTMLFormElement)
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([, init]) => init?.method === "PATCH")
      ).toBe(true)
    )
    const call = apiMock.mock.calls.find(
      ([, init]) => init?.method === "PATCH"
    )!
    expect(JSON.parse(String(call[1]?.body)).mount).toBe("left")
  })
})
