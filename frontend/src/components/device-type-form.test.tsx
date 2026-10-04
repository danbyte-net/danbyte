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
import type { DeviceType, DeviceTypeWritePayload } from "@/lib/api"
import { DeviceTypeForm } from "./device-type-form"
import type { DeviceTypeFormProps } from "./device-type-form"

// A device type's body size and the DIN rails it mounts on (#277): sizes in
// tenths of a millimetre, blank sent as cleared; the profiles ticked, in the
// order the API lists them; the rail's position, blank for the middle.

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
  apiMock.mockImplementation((_path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      if (refuse) return Promise.reject(new ApiError(400, refuse))
      return Promise.resolve({
        id: "t-new",
        ...(JSON.parse(String(init.body)) as object),
      })
    }
    return page([])
  })
})
afterEach(cleanup)
// A whole edit form in jsdom takes its time when the whole suite runs.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5000 })

function renderForm(props: Partial<DeviceTypeFormProps> = {}) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <DeviceTypeForm onSaved={onSaved} onCancel={() => {}} {...props} />
    </QueryClientProvider>
  )
  return { onSaved }
}

function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}
const box = (label: string) =>
  within(field(label)).getByRole<HTMLInputElement>("spinbutton")
const type = (label: string, value: string) =>
  fireEvent.change(box(label), { target: { value } })
const profile = (name: string) =>
  screen.getByRole("checkbox", { name: new RegExp(`^${name}$`) })

function submit() {
  const button = screen.getByRole("button", {
    name: /Create device type|Save changes/,
  })
  fireEvent.submit(button.closest("form") as HTMLFormElement)
}

async function sent(): Promise<DeviceTypeWritePayload> {
  await waitFor(() =>
    expect(
      apiMock.mock.calls.some(
        ([, i]) => i?.method === "POST" || i?.method === "PATCH"
      )
    ).toBe(true)
  )
  const call = apiMock.mock.calls.find(
    ([, i]) => i?.method === "POST" || i?.method === "PATCH"
  )!
  return JSON.parse(String(call[1]?.body)) as DeviceTypeWritePayload
}

const DIN_TYPE = {
  id: "t1",
  name: "Relay",
  manufacturer: null,
  model: "",
  part_number: "",
  platform: null,
  u_height: 0,
  rack_width: "full",
  description: "",
  is_full_depth: false,
  airflow: "",
  weight: null,
  weight_unit: "kg",
  subdevice_role: "",
  exclude_from_utilization: false,
  width_mm: 17.5,
  height_mm: 90,
  depth_mm: 62,
  din_profiles: ["ts35", "ts15"],
  din_rail_mm: 45,
  tags: [],
  custom_fields: {},
} as unknown as DeviceType

describe("DeviceTypeForm size and DIN rail", () => {
  it("sends the body size, the profiles ticked and the rail's position", async () => {
    renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "PLC" },
    })
    type("Width (mm)", "60")
    type("Height (mm)", "147.5")
    // G 32 before TS 35: the payload still lists them in the API's order.
    fireEvent.click(profile("G 32"))
    fireEvent.click(profile("TS 35"))
    type("Rail position (mm)", "40")
    submit()
    const body = await sent()
    expect(body).toMatchObject({
      width_mm: 60,
      height_mm: 147.5,
      depth_mm: null,
      din_profiles: ["ts35", "g32"],
      din_rail_mm: 40,
    })
  })

  it("sends a blank rail position as the middle, and no profiles as not DIN", async () => {
    renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "Switch" },
    })
    submit()
    expect(await sent()).toMatchObject({
      width_mm: null,
      height_mm: null,
      din_profiles: [],
      din_rail_mm: null,
    })
  })

  it("starts from the type it edits, and clears what is blanked", async () => {
    renderForm({ deviceType: DIN_TYPE })
    expect(box("Width (mm)").value).toBe("17.5")
    expect(box("Depth (mm)").value).toBe("62")
    expect(box("Rail position (mm)").value).toBe("45")
    expect(profile("TS 35").getAttribute("data-state")).toBe("checked")
    expect(profile("TS 15").getAttribute("data-state")).toBe("checked")
    expect(profile("G 32").getAttribute("data-state")).toBe("unchecked")

    fireEvent.click(profile("TS 15"))
    type("Depth (mm)", "")
    submit()
    expect(await sent()).toMatchObject({
      width_mm: 17.5,
      depth_mm: null,
      din_profiles: ["ts35"],
      din_rail_mm: 45,
    })
  })

  it("explains the rail position behind the info icon", async () => {
    renderForm()
    fireEvent.focus(
      within(field("Rail position (mm)")).getByRole("button", {
        name: "More information",
      })
    )
    expect(
      await screen.findByText("Centreline below the top edge; empty = middle")
    ).toBeTruthy()
  })

  it("shows the server's refusal on the field it is about", async () => {
    refuse = {
      width_mm: ["A DIN-rail type needs its body size."],
      din_rail_mm: ["Below the body (90 mm tall)."],
    }
    renderForm({ deviceType: DIN_TYPE })
    submit()
    expect(
      await within(field("Width (mm)")).findByText(
        "A DIN-rail type needs its body size."
      )
    ).toBeTruthy()
    expect(
      within(field("Rail position (mm)")).getByText(
        "Below the body (90 mm tall)."
      )
    ).toBeTruthy()
  })
})
