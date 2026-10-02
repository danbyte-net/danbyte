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
import type React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { ApiError } from "@/lib/api"
import type { Cabinet, Device, DeviceTypeMini } from "@/lib/api"
import { CabinetPlateSection } from "./cabinet-plate-section"

// The cabinet page's Arrange mode: a device picked on the plate moves as in
// the device form, the moves wait - drawn where they go, red where they
// clash - and Save sends them all in one request the server checks as a
// whole. A press on a free stretch with nothing picked offers to add a
// device there or assign one.

const { apiMock, toastMock, successMock, canDo } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: vi.fn(),
  successMock: vi.fn(),
  canDo: vi.fn((_type: string, _action: string) => true),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))
vi.mock("sonner", () => ({ toast: { success: successMock, error: vi.fn() } }))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo }) }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
  useBlocker: () => ({ status: "idle" }),
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children?: React.ReactNode
    to: string
    search?: Record<string, string>
  }) => (
    <a href={`${to}?${new URLSearchParams(search).toString()}`} {...rest}>
      {children}
    </a>
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

const PLC: DeviceTypeMini = {
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

/** K1: a 525 mm TS 35 rail along the top (R1) and another lower down. */
const K1 = {
  id: "c1",
  name: "K1",
  site: { id: "s1", name: "Plant" },
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
      profile: "ts35",
      x_mm: 0,
      y_mm: 300,
      length_mm: 525,
    },
  ],
} as unknown as Cabinet

const on = (id: string, rail: "r1" | "r2", offset: number) =>
  ({
    id,
    name: id,
    role: null,
    device_type: PLC,
    cabinet: { id: "c1", name: "K1" },
    din_rail: { id: rail, label: rail.toUpperCase(), profile: "ts35" },
    din_offset_mm: offset,
  }) as unknown as Device
// "a" and "b" side by side at the left of R1, "c" at the left of R2.
const DEVICES = [on("a", "r1", 0), on("b", "r1", 60), on("c", "r2", 0)]

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

beforeEach(() => {
  apiMock.mockReset()
  toastMock.mockReset()
  successMock.mockReset()
  canDo.mockImplementation(() => true)
  apiMock.mockImplementation((path, init) => {
    if (path === "/api/cabinets/c1/arrange/")
      return Promise.resolve({ devices: [] })
    if (init?.method === "PATCH")
      return Promise.resolve({
        id: "d9",
        name: "plc-9",
        din_rail: { id: "r1", label: "R1", profile: "ts35" },
        din_offset_mm: 300,
      })
    if (path === "/api/devices/?picker=1&site=s1&din_profile=ts35")
      return page([{ id: "d9", name: "plc-9" }])
    return page([])
  })
})
afterEach(cleanup)
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5000 })

function renderPlate() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
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
      />
    </QueryClientProvider>
  )
}

const button = (name: string) =>
  screen.getByRole<HTMLButtonElement>("button", { name })
const target = () => {
  const el = document.querySelector('[data-part="target"]')
  if (!el) throw new Error("not arranging")
  return el
}
/** Where a device's body is drawn, and how it is marked. */
const body = (name: string) => {
  const r = document.querySelector(
    `[data-device="${name}"] [data-part="outline"]`
  )
  if (!r) throw new Error(`no device ${name}`)
  return {
    x: Number(r.getAttribute("x")),
    y: Number(r.getAttribute("y")),
    mark: r.getAttribute("data-mark"),
  }
}
const status = () =>
  document.querySelector('[data-part="status"]')?.textContent ?? ""

/** Turn Arrange on and pick a device by clicking its body. */
function pick(name: string, x: number, y = 75) {
  fireEvent.click(target(), { clientX: x, clientY: y })
  return screen.getByRole("slider", { name })
}

describe("Arrange", () => {
  it("is offered only to those who may change devices", () => {
    canDo.mockImplementation((_t, action) => action !== "change")
    renderPlate()
    expect(screen.queryByRole("button", { name: "Arrange" })).toBeNull()
  })

  it("leaves the plate as it is until it is on", () => {
    renderPlate()
    // The devices link to their pages, and the plate takes no presses.
    expect(document.querySelector('[data-part="target"]')).toBeNull()
    expect(
      document.querySelector('[data-device="a"]')?.getAttribute("role")
    ).toBe("link")
    fireEvent.click(button("Arrange"))
    expect(target()).toBeTruthy()
    // Arranging, a device is picked, not opened.
    expect(
      document.querySelector('[data-device="a"]')?.getAttribute("role")
    ).toBe("button")
  })

  it("picks a device from the keyboard, and the keys move it on", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    fireEvent.keyDown(screen.getByRole("button", { name: "b" }), {
      key: "Enter",
    })
    const outline = await screen.findByRole("slider", { name: "b" })
    await waitFor(() => expect(document.activeElement).toBe(outline))
    fireEvent.keyDown(outline, { key: "ArrowRight" })
    await waitFor(() => expect(body("b").x).toBe(61))
  })

  it("picks a device with a click, moves it, and draws it where it goes", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    const b = pick("b", 90)
    fireEvent.keyDown(b, { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(body("b")).toMatchObject({ x: 70 }))
    expect(body("b").mark).toBe("moved")
    expect(body("a").mark).toBeNull()
    // Picked up 30 mm into it, dragged down onto R2 and let go there.
    const outline = screen.getByRole("slider", { name: "b" })
    const at = (x: number, y: number) => ({
      clientX: x,
      clientY: y,
      pointerId: 1,
    })
    fireEvent.pointerDown(outline, { ...at(100, 75), button: 0 })
    fireEvent.pointerMove(outline, at(140, 300))
    fireEvent.pointerUp(outline, at(140, 300))
    await waitFor(() => expect(body("b")).toMatchObject({ x: 110 }))
    // Hung on R2 now: 300 less half its 147 mm.
    expect(body("b").y).toBe(226.5)
    // The slider follows it.
    expect(
      screen
        .getByRole("slider", { name: "Offset" })
        .getAttribute("aria-valuenow")
    ).toBe("110")
  })

  it("saves every move in one request, and only the moves", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    expect(button("Save").disabled).toBe(true)
    fireEvent.keyDown(pick("b", 90), { key: "ArrowRight" })
    await waitFor(() => expect(body("b").x).toBe(61))
    fireEvent.keyDown(pick("c", 30, 300), { key: "ArrowRight", shiftKey: true })
    await waitFor(() => expect(body("c").x).toBe(10))
    fireEvent.click(button("Save"))
    await waitFor(() =>
      expect(successMock).toHaveBeenCalledWith("Moved 2 devices")
    )
    const calls = apiMock.mock.calls.filter(([, i]) => i?.method === "POST")
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe("/api/cabinets/c1/arrange/")
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      placements: [
        { device_id: "b", din_rail_id: "r1", din_offset_mm: 61 },
        { device_id: "c", din_rail_id: "r2", din_offset_mm: 10 },
      ],
    })
    // Done arranging.
    await waitFor(() => expect(button("Arrange")).toBeTruthy())
  })

  it("holds the save back while a move clashes, red on both sides", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    fireEvent.keyDown(pick("b", 90), { key: "ArrowLeft" })
    await waitFor(() => expect(body("b").mark).toBe("clash"))
    expect(body("a").mark).toBe("clash")
    expect(button("Save").disabled).toBe(true)
    expect(status()).toBe("Overlaps a at 0-60 mm.")
  })

  it("puts the server's refusal on the device it names", async () => {
    apiMock.mockImplementation((path) =>
      path === "/api/cabinets/c1/arrange/"
        ? Promise.reject(
            new ApiError(400, {
              placements: [{ din_offset_mm: ["Overlaps x at 0-90 mm."] }],
            })
          )
        : page([])
    )
    renderPlate()
    fireEvent.click(button("Arrange"))
    fireEvent.keyDown(pick("b", 90), { key: "ArrowRight" })
    await waitFor(() => expect(body("b").x).toBe(61))
    fireEvent.click(button("Save"))
    await waitFor(() => expect(body("b").mark).toBe("clash"))
    expect(status()).toBe("Overlaps x at 0-90 mm.")
    // Still arranging, the move kept.
    expect(button("Save")).toBeTruthy()
    // Dropping the pick names the device the refusal is about.
    fireEvent.keyDown(screen.getByRole("slider", { name: "b" }), {
      key: "Escape",
    })
    await waitFor(() => expect(status()).toBe("b: Overlaps x at 0-90 mm."))
  })

  it("puts everything back on Cancel", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    fireEvent.keyDown(pick("b", 90), { key: "ArrowRight" })
    await waitFor(() => expect(body("b").x).toBe(61))
    fireEvent.click(button("Cancel"))
    expect(body("b")).toMatchObject({ x: 60, mark: null })
    expect(button("Arrange")).toBeTruthy()
    expect(apiMock.mock.calls.some(([, i]) => i?.method === "POST")).toBe(false)
  })

  it("offers to add a device at a free spot, or assign one there", async () => {
    renderPlate()
    fireEvent.click(button("Arrange"))
    // 300 mm along R1, nothing picked.
    fireEvent.click(target(), { clientX: 300, clientY: 75 })
    const add = await screen.findByRole("menuitem", { name: "Add device here" })
    const href = add.getAttribute("href") ?? ""
    expect(href.startsWith("/devices/new?")).toBe(true)
    expect(Object.fromEntries(new URLSearchParams(href.split("?")[1]))).toEqual(
      { cabinet: "c1", din_rail: "r1", din_offset: "300", site: "s1" }
    )

    fireEvent.click(screen.getByRole("menuitem", { name: "Assign here" }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByRole("heading").textContent).toBe(
      "Assign to R1 · 300 mm"
    )
    fireEvent.click(within(dialog).getByRole("combobox"))
    fireEvent.click(await screen.findByRole("option", { name: "plc-9" }))
    fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }))
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(
        true
      )
    )
    const patch = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")!
    expect(patch[0]).toBe("/api/devices/d9/")
    expect(JSON.parse(String(patch[1]?.body))).toEqual({
      din_rail_id: "r1",
      din_offset_mm: 300,
    })
  })
})
