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
import type { Cabinet, Device } from "@/lib/api"
import { CabinetRailActions } from "./cabinet-rail-actions"

// Devices go on a cabinet's rails from its plate's heading: Add device opens
// the new-device form on a rail, Assign puts an existing device at the
// cabinet's site on one - with no offset, so it takes the first gap.

const { apiMock, toastMock, successMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: vi.fn(),
  successMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))
vi.mock("sonner", () => ({ toast: { success: successMock, error: vi.fn() } }))
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canDo: () => true }) }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
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

const K1 = {
  id: "c1",
  name: "K1",
  site: { id: "s1", name: "Plant" },
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
} as unknown as Cabinet

const onR1 = (id: string, offset: number, width: number) =>
  ({
    id,
    name: id,
    din_rail: { id: "r1", label: "R1", profile: "ts35" },
    din_offset_mm: offset,
    device_type: { width_mm: width },
  }) as unknown as Device
const DEVICES = [onR1("a", 0, 60), onR1("b", 300, 45)]

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
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "PATCH")
      return Promise.resolve({
        id: "d9",
        name: "plc-9",
        din_rail: { id: "r2", label: "R2", profile: "ts15" },
        din_offset_mm: 0,
      })
    // Assign on R2 offers only devices that mount on its TS 15 profile.
    if (path === "/api/devices/?picker=1&site=s1&din_profile=ts15")
      return page([{ id: "d9", name: "plc-9" }])
    return page([])
  })
})
afterEach(cleanup)
// A menu, a dialog and a picker in jsdom take their time when the whole
// suite runs.
vi.setConfig({ testTimeout: 30_000 })
configure({ asyncUtilTimeout: 5000 })

function renderActions() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <CabinetRailActions cabinet={K1} devices={DEVICES} />
    </QueryClientProvider>
  )
}

function openMenu(name: "Add device" | "Assign") {
  fireEvent.pointerDown(
    screen.getByRole("button", { name }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
  return screen.getAllByRole("menuitem")
}

async function assignTo(rail: string) {
  const item = openMenu("Assign").find((i) => i.textContent.includes(rail))!
  fireEvent.click(item)
  const dialog = await screen.findByRole("dialog")
  fireEvent.click(within(dialog).getByRole("combobox"))
  fireEvent.click(await screen.findByRole("option", { name: "plc-9" }))
  fireEvent.click(within(dialog).getByRole("button", { name: "Assign" }))
  return dialog
}

describe("CabinetRailActions", () => {
  it("lists each rail with its widest free stretch", () => {
    renderActions()
    const items = openMenu("Add device").map((i) => i.textContent)
    // R1: 0-60 and 300-345 taken, so 60-300 is the widest gap.
    expect(items).toEqual(["R1TS 35240 mm free", "R2TS 15300 mm free"])
  })

  it("opens the new-device form on the rail, with no offset", () => {
    renderActions()
    const r2 = openMenu("Add device")[1]
    const href = r2.getAttribute("href") ?? ""
    expect(href.startsWith("/devices/new?")).toBe(true)
    expect(Object.fromEntries(new URLSearchParams(href.split("?")[1]))).toEqual(
      { cabinet: "c1", din_rail: "r2", site: "s1" }
    )
  })

  it("assigns a device at the cabinet's site with just the rail", async () => {
    renderActions()
    await assignTo("R2")
    await waitFor(() =>
      expect(successMock).toHaveBeenCalledWith("plc-9 on R2 at 0 mm")
    )
    const patch = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")!
    expect(patch[0]).toBe("/api/devices/d9/")
    // The server takes the first gap it fits in.
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ din_rail_id: "r2" })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("shows a refusal and keeps the dialog open", async () => {
    const err = new ApiError(400, {
      din_rail_id: ["No gap on R2 is 90 mm wide."],
    })
    apiMock.mockImplementation((path, init) =>
      init?.method === "PATCH"
        ? Promise.reject(err)
        : path === "/api/devices/?picker=1&site=s1&din_profile=ts15"
          ? page([{ id: "d9", name: "plc-9" }])
          : page([])
    )
    renderActions()
    await assignTo("R2")
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(err))
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(successMock).not.toHaveBeenCalled()
  })
})
