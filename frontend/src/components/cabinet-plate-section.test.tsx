// @vitest-environment jsdom
import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type { Cabinet, Device, DeviceTypeMini } from "@/lib/api"
import { CabinetPlateSection } from "./cabinet-plate-section"

// The cabinet page's Plate takes the rack elevation's controls: Names,
// Images or Render; its labels on or off; a zoom in steps, with the plate
// fitted to its column as one of them; and a PNG of the drawing - all kept
// in this browser, so the page reopens as it was left. Arrange works in
// Names and Images, and draws Images while Render is picked.

const { apiMock, canDo, pngMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  canDo: vi.fn((_type: string, _action: string) => true),
  pngMock: vi.fn<(el: HTMLElement, name: string) => Promise<void>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo }) }))
vi.mock("@/lib/png-export", () => ({ downloadPng: pngMock }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
  useBlocker: () => ({ status: "idle" }),
  Link: ({ children, to }: { children?: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))
// The faceplates themselves are the device page's, tested with it and in
// cabinet-faceplates.test.tsx; here, which one each device gets.
vi.mock("@/components/device-faceplate", async (orig) => ({
  ...(await orig<object>()),
  useObservedPorts: () => null,
  FaceplateView: (p: {
    mode: string
    deviceId: string
    fill?: boolean
    fit?: number
  }) => (
    <div
      data-testid="faceplate"
      data-device={p.deviceId}
      data-mode={p.mode}
      data-fill={p.fill ? "" : undefined}
      data-fit={p.fit}
    />
  ),
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
Element.prototype.setPointerCapture = () => {}
Element.prototype.releasePointerCapture = () => {}
// jsdom lays nothing out: take a pointer's screen pixels to be the plate's
// millimetres.
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

/** A photo that loads at once, 100 × 245 px. */
class PhotoStub {
  onload: (() => void) | null = null
  naturalWidth = 0
  naturalHeight = 0
  set src(_url: string) {
    queueMicrotask(() => {
      this.naturalWidth = 100
      this.naturalHeight = 245
      this.onload?.()
    })
  }
}

const type = (patch: Partial<DeviceTypeMini>): DeviceTypeMini => ({
  id: "t-photo",
  name: "XC216",
  manufacturer: null,
  manufacturer_id: null,
  u_height: 0,
  rack_width: "full",
  is_full_depth: false,
  width_mm: 140,
  height_mm: 147,
  din_profiles: ["ts35"],
  din_rail_mm: null,
  front_image: "/media/xc216.png",
  rear_image: null,
  ...patch,
})
const PHOTO = type({})
const CAL = type({
  id: "t-cal",
  name: "XC206",
  width_mm: 60,
  front_image: "/media/xc206.png",
  front_cal: { left: 0.1, right: 0.9, span_mm: 48, rail: 0.55, photo_mm: 60 },
})
const SCHEMATIC = type({
  id: "t-sch",
  name: "PLC",
  width_mm: 60,
  height_mm: 100,
  front_image: null,
})
const BARE = type({
  id: "t-bare",
  name: "Relay",
  width_mm: 20,
  height_mm: 80,
  front_image: null,
})

/** K1, as the test cabinet: a 500 × 600 mm plate in a 550 × 650 mm box,
 * so the drawing's frame is 563 × 663 mm. */
const K1 = {
  id: "c1",
  name: "K1",
  site: { id: "s1", name: "Plant" },
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 550,
  outer_height_mm: 650,
  outer_depth_mm: 200,
  rails: [
    {
      id: "r1",
      label: "R1",
      profile: "ts35",
      x_mm: 0,
      y_mm: 95,
      length_mm: 500,
    },
    {
      id: "r2",
      label: "R2",
      profile: "ts35",
      x_mm: 0,
      y_mm: 286,
      length_mm: 500,
    },
  ],
} as unknown as Cabinet

const ROLE = {
  id: "ro1",
  name: "Access",
  slug: "access",
  color: "#2563eb",
  icon: "",
}

const on = (id: string, t: DeviceTypeMini, rail: "r1" | "r2", offset: number) =>
  ({
    id,
    name: id,
    role: ROLE,
    device_type: t,
    vc_position: null,
    port_labels: "",
    image_ports: null,
    cabinet: { id: "c1", name: "K1" },
    din_rail: { id: rail, label: rail.toUpperCase(), profile: "ts35" },
    din_offset_mm: offset,
  }) as unknown as Device
const DEVICES = [
  on("sw-1", PHOTO, "r1", 0),
  on("sw-2", CAL, "r1", 140),
  on("plc-1", SCHEMATIC, "r2", 0),
  on("relay-1", BARE, "r2", 100),
]

const page = (results: unknown[]) => ({
  count: results.length,
  next: null,
  previous: null,
  results,
})
const marker = { kind: "interface", name: "P1", x: 0.5, y: 0.5, w: 0.1, h: 0.1 }
const ROUTES: Record<string, unknown> = {
  "/api/device-types/t-photo/": {
    ...PHOTO,
    image_ports: { front: [marker], rear: [] },
  },
  "/api/device-types/t-cal/": {
    ...CAL,
    image_ports: { front: [marker], rear: [] },
  },
  "/api/device-types/t-sch/": { ...SCHEMATIC, image_ports: null },
  "/api/device-types/t-bare/": { ...BARE, image_ports: null },
  "/api/devices/sw-1/interfaces/": page([
    { id: "i1", name: "P1", virtual: false },
  ]),
  "/api/devices/sw-2/interfaces/": page([
    { id: "i2", name: "P1", virtual: false },
  ]),
  "/api/devices/plc-1/interfaces/": page([
    { id: "i3", name: "eth1", virtual: false },
  ]),
  "/api/devices/relay-1/interfaces/": page([]),
}

const KEY = "danbyte.cabinetPlate.view"

beforeEach(() => {
  localStorage.clear()
  apiMock.mockReset()
  pngMock.mockReset()
  pngMock.mockResolvedValue()
  canDo.mockImplementation(() => true)
  apiMock.mockImplementation((path) =>
    path in ROUTES
      ? Promise.resolve(ROUTES[path])
      : Promise.reject(new ApiError(404, { detail: "Not found." }))
  )
  vi.stubGlobal("Image", PhotoStub)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5000 })

function renderPlate(
  props: Partial<React.ComponentProps<typeof CabinetPlateSection>> = {}
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <CabinetPlateSection
        sizes={K1}
        rails={K1.rails}
        endpoint="/api/cabinets/c1/"
        railKey="rails"
        editTitle="Rails · K1"
        canEdit={false}
        devices={DEVICES}
        cabinet={K1}
        {...props}
      />
    </QueryClientProvider>
  )
}

const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>("button", { name })
const tab = (name: "Names" | "Images" | "Render") => button(name)
const active = () =>
  screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-current") === "page")
    .map((b) => b.textContent)
const labels = () => screen.getByRole("checkbox", { name: "Labels" })
/** The plate's drawing - not one of the toolbar's icons. */
const svg = () =>
  document.querySelector<SVGSVGElement>('svg[aria-label^="Plate"]')!
/** The drawing's px per mm: its width over the 563 mm frame. */
const zoom = () =>
  Math.round((Number.parseFloat(svg().style.width) / 563) * 1000) / 1000
/** jsdom has no layout: the column is taken to be 480 px, which fits the
 * 663 mm-tall frame at 448 / 663 px per mm. */
const FIT = Math.round((448 / 663) * 1000) / 1000
const names = () =>
  [...document.querySelectorAll('[data-part="name"]')].map((n) => n.textContent)
const railTags = () =>
  [...document.querySelectorAll("[data-rail-tag]")].map((t) =>
    t.getAttribute("data-rail-tag")
  )
const faces = () =>
  [...document.querySelectorAll<HTMLElement>("[data-face]")].map(
    (f) => `${f.dataset.face}:${f.dataset.look}`
  )
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? "null")

describe("the Plate's controls", () => {
  it("opens on Images, fitted to the column, as the plate always was", async () => {
    renderPlate()
    expect(active()).toEqual(["Images"])
    expect(zoom()).toBe(FIT)
    expect(labels().getAttribute("aria-checked")).toBe("true")
    // The photos: sw-1's stretched over its body, sw-2's at true size once
    // its photo has loaded.
    await waitFor(() =>
      expect(document.querySelectorAll("image")).toHaveLength(2)
    )
    expect(document.querySelector("[data-calibrated]")).not.toBeNull()
    expect(faces()).toEqual([])
  })

  it("switches to Names: role-coloured boxes with readable names, no photos", () => {
    renderPlate()
    fireEvent.click(tab("Names"))
    expect(active()).toEqual(["Names"])
    expect(document.querySelectorAll("image")).toHaveLength(0)
    const body = document.querySelector<SVGElement>(
      '[data-device="sw-1"] [data-part="body"]'
    )
    expect(body?.style.fill).toBe("rgb(37, 99, 235)") // #2563eb
    const name = document.querySelector<SVGElement>(
      '[data-device="sw-1"] [data-part="name"]'
    )
    expect(name?.style.fill).toBe("rgb(255, 255, 255)") // light ink on blue
    expect(names()).toContain("sw-1")
  })

  it("switches to Render: a faceplate per device that has one, drawn larger", async () => {
    renderPlate()
    fireEvent.click(tab("Render"))
    expect(active()).toEqual(["Render"])
    // Render's own zoom, as on the rack.
    expect(zoom()).toBe(1.3)
    await waitFor(() =>
      expect(faces()).toEqual(["sw-1:photo", "sw-2:photo", "plc-1:schematic"])
    )
    // Photo ports stretched over the body, or at true size; the schematic
    // at the drawing's scale, shrunk into its body.
    const view = (id: string) =>
      document.querySelector<HTMLElement>(
        `[data-testid=faceplate][data-device="${id}"]`
      )?.dataset
    expect(view("sw-1")).toMatchObject({ mode: "image", fill: "" })
    expect(view("sw-2")).toMatchObject({ mode: "image", fill: "" })
    expect(view("plc-1")).toMatchObject({ mode: "rendered", fit: "1.3" })
    // Each over its body: sw-1 at 0 along R1, hung on its middle.
    const sw1 = document.querySelector<HTMLElement>('[data-face="sw-1"]')!
    expect(
      ["left", "top", "width", "height"].map(
        (k) =>
          Math.round(Number.parseFloat(sw1.style.getPropertyValue(k)) * 100) /
          100
      )
    ).toEqual([40.95, 68.9, 182, 191.1])
    // Back on Images, the faceplates go and the plate fits again.
    fireEvent.click(tab("Images"))
    expect(faces()).toEqual([])
    expect(zoom()).toBe(FIT)
  })

  it("writes or leaves out the labels", () => {
    renderPlate()
    expect(names()).toEqual(expect.arrayContaining(["sw-1", "plc-1"]))
    expect(railTags()).toEqual(["R1", "R2"])
    fireEvent.click(labels())
    expect(labels().getAttribute("aria-checked")).toBe("false")
    // Images keeps the rails' labels to find the way by.
    expect(names()).toEqual([])
    expect(railTags()).toEqual(["R1", "R2"])
    // Names goes without a word.
    fireEvent.click(tab("Names"))
    expect(names()).toEqual([])
    expect(railTags()).toEqual([])
    fireEvent.click(labels())
    expect(names()).toEqual(expect.arrayContaining(["sw-1", "plc-1"]))
    expect(railTags()).toEqual(["R1", "R2"])
  })

  it("zooms in steps, with fit as one, and stops at either end", () => {
    renderPlate()
    const zoomIn = button("Zoom in")
    const zoomOut = button("Zoom out")
    fireEvent.click(zoomIn)
    expect(zoom()).toBe(0.8)
    fireEvent.click(zoomIn)
    expect(zoom()).toBe(1)
    fireEvent.click(zoomOut)
    fireEvent.click(zoomOut)
    expect(zoom()).toBe(FIT)
    fireEvent.click(zoomOut)
    expect(zoom()).toBe(0.6)
    fireEvent.click(zoomOut)
    expect(zoom()).toBe(0.45)
    expect(zoomOut.disabled).toBe(true)
    for (let i = 0; i < 9; i++) fireEvent.click(zoomIn)
    expect(zoom()).toBe(3)
    expect(zoomIn.disabled).toBe(true)
    // Wider than the column, it scrolls in its frame.
    expect(svg().closest(".overflow-auto")).not.toBeNull()
  })

  it("exports the drawing as <cabinet>-plate.png", () => {
    renderPlate()
    fireEvent.click(tab("Render"))
    fireEvent.click(button("PNG"))
    expect(pngMock).toHaveBeenCalledTimes(1)
    const [el, name] = pngMock.mock.calls[0]
    expect(name).toBe("K1-plate.png")
    // The drawing: the plate and the faceplates over it, not the controls.
    expect(el.dataset.part).toBe("drawing")
    expect(el.contains(svg())).toBe(true)
    expect(el.querySelector('[data-part="faceplates"]')).not.toBeNull()
    expect(el.contains(button("PNG"))).toBe(false)
  })

  it("remembers the mode, the zoom and the labels in this browser", () => {
    const first = renderPlate()
    fireEvent.click(tab("Names"))
    fireEvent.click(button("Zoom in"))
    fireEvent.click(labels())
    expect(stored()).toEqual({ mode: "names", zoom: 0.8, labels: false })
    first.unmount()
    renderPlate()
    expect(active()).toEqual(["Names"])
    expect(zoom()).toBe(0.8)
    expect(labels().getAttribute("aria-checked")).toBe("false")
  })

  it("reopens on Render as it was left", async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ mode: "render", zoom: 2, labels: true })
    )
    renderPlate()
    expect(active()).toEqual(["Render"])
    expect(zoom()).toBe(2)
    await waitFor(() => expect(faces()).toHaveLength(3))
  })

  it("leaves a cabinet type's plate as it was drawn", () => {
    renderPlate({ devices: undefined, cabinet: undefined })
    expect(screen.queryByRole("button", { name: "Render" })).toBeNull()
    expect(screen.queryByRole("button", { name: "PNG" })).toBeNull()
    // Filling its column, as before the zoom.
    expect(svg().getAttribute("class")).toContain("w-full")
    expect(svg().style.width).toBe("")
  })
})

describe("Arrange with the controls", () => {
  it("draws Images while Render is picked, and goes back to Render after", async () => {
    renderPlate()
    fireEvent.click(tab("Render"))
    await waitFor(() => expect(faces()).toHaveLength(3))
    fireEvent.click(button("Arrange"))
    // The placer: photos, Render out of the tabs, no PNG, the zoom kept.
    expect(document.querySelector('[data-part="target"]')).not.toBeNull()
    expect(faces()).toEqual([])
    expect(screen.queryByRole("button", { name: "Render" })).toBeNull()
    expect(active()).toEqual(["Images"])
    expect(screen.queryByRole("button", { name: "PNG" })).toBeNull()
    expect(zoom()).toBe(1.3)
    await waitFor(() =>
      expect(document.querySelectorAll("image").length).toBeGreaterThan(0)
    )
    // Render is still the pick.
    expect(stored()).toEqual({ mode: "render", zoom: 1.3, labels: true })
    fireEvent.click(button("Cancel"))
    expect(active()).toEqual(["Render"])
    await waitFor(() => expect(faces()).toHaveLength(3))
  })

  it("keeps Names, its labels and its zoom while arranging", () => {
    renderPlate()
    fireEvent.click(tab("Names"))
    fireEvent.click(button("Zoom in"))
    fireEvent.click(button("Arrange"))
    expect(active()).toEqual(["Names"])
    expect(zoom()).toBe(0.8)
    expect(document.querySelectorAll("image")).toHaveLength(0)
    expect(
      document.querySelector<SVGElement>(
        '[data-device="sw-1"] [data-part="body"]'
      )?.style.fill
    ).toBe("rgb(37, 99, 235)")
    fireEvent.click(labels())
    expect(names()).toEqual([])
    expect(railTags()).toEqual([])
    // Picking and moving a device works as it does in Images.
    fireEvent.click(document.querySelector('[data-part="target"]')!, {
      clientX: 30,
      clientY: 95,
    })
    expect(screen.getByRole("slider", { name: "sw-1" })).toBeTruthy()
    // And the mode can change while arranging.
    fireEvent.click(tab("Images"))
    expect(active()).toEqual(["Images"])
    expect(document.querySelector('[data-part="target"]')).not.toBeNull()
  })
})
