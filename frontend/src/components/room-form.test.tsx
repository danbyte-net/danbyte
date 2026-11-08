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
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { Room, RoomWritePayload } from "@/lib/api"
import { RoomForm } from "./room-form"
import type { RoomFormProps } from "./room-form"
import { FormRoomCombobox } from "./room-field"

// A room lives in a location: the form picks the site, then a location in it,
// and starts a new room on the status flagged default for rooms. The Room
// picker on the device, rack and cabinet forms lists the rooms of the
// object's location, each as its colour badge, and waits for a location.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
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

const status = (id: string, name: string, defaultFor: string[]) => ({
  id,
  name,
  slug: name.toLowerCase(),
  color: "#10b981",
  text_color: "#ffffff",
  available_to: ["room"],
  default_for: defaultFor,
})

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({
        id: "rm-new",
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/sites/") return page([{ id: "s1", name: "HQ" }])
    if (path === "/api/locations/?picker=1&site=s1")
      return page([{ id: "l1", name: "Floor 2", slug: "floor-2" }])
    if (path === "/api/statuses/?available_to=room&picker=1")
      return page([
        status("st-planned", "Planned", []),
        status("st-active", "Active", ["room"]),
      ])
    if (path === "/api/rooms/?picker=1&location=l1")
      return page([
        {
          id: "rm1",
          name: "Comms 210",
          slug: "comms-210",
          code: "210",
          color: "#2563eb",
          location_id: "l1",
        },
      ])
    return page([])
  })
})
afterEach(cleanup)

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

function renderForm(props: Partial<RoomFormProps> = {}) {
  const onSaved = vi.fn()
  wrap(<RoomForm onSaved={onSaved} onCancel={() => {}} {...props} />)
  return { onSaved }
}

function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}

async function pick(label: string, option: string) {
  fireEvent.click(within(field(label)).getByRole("combobox"))
  fireEvent.click(await screen.findByText(option))
}

function sent(): RoomWritePayload & Record<string, unknown> {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as RoomWritePayload &
    Record<string, unknown>
}

describe("RoomForm", () => {
  it("creates a room in the picked location with the default status", async () => {
    const { onSaved } = renderForm()
    await waitFor(() =>
      expect(
        within(field("Status")).getByRole("combobox").textContent
      ).toContain("Active")
    )
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: " Comms 211 " },
    })
    fireEvent.change(within(field("Code")).getByRole("textbox"), {
      target: { value: "211" },
    })
    await pick("Site", "HQ")
    await pick("Location", "Floor 2")
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Create room" })
        .closest("form") as HTMLFormElement
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const [path] = apiMock.mock.calls.find(([, i]) => i?.method === "POST")!
    expect(path).toBe("/api/rooms/")
    expect(sent()).toMatchObject({
      name: "Comms 211",
      code: "211",
      location_id: "l1",
      status_id: "st-active",
    })
  })

  it("opens on the location it was added from", async () => {
    renderForm({ initialSiteId: "s1", initialLocationId: "l1" })
    await waitFor(() =>
      expect(
        within(field("Location")).getByRole("combobox").textContent
      ).toContain("Floor 2")
    )
  })

  it("keeps an edited room's own status", async () => {
    const room: Room = {
      id: "rm1",
      numid: 1,
      name: "Comms 210",
      slug: "comms-210",
      code: "210",
      location: { id: "l1", name: "Floor 2", color: "", icon: "" },
      site: { id: "s1", name: "HQ" },
      status: null,
      color: "",
      description: "",
      device_count: 0,
      rack_count: 0,
      cabinet_count: 0,
      tags: [],
      custom_fields: {},
      created_at: "2026-10-30T00:00:00Z",
      updated_at: "2026-10-30T00:00:00Z",
    }
    renderForm({ room })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/statuses/?available_to=room&picker=1"
      )
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(
      within(field("Status")).getByRole("combobox").textContent
    ).not.toContain("Active")
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy()
  })
})

function PickerHarness({ initial }: { initial: string | null }) {
  const [locationId] = useState<string | null>(initial)
  const [roomId, setRoomId] = useState<string | null>(null)
  return (
    <>
      <FormRoomCombobox
        locationId={locationId}
        value={roomId}
        onChange={setRoomId}
      />
      <output>{roomId ?? "none"}</output>
    </>
  )
}

describe("the Room picker", () => {
  it("waits for a location", () => {
    wrap(<PickerHarness initial={null} />)
    const trigger = within(field("Room")).getByRole("combobox")
    expect(trigger.hasAttribute("disabled")).toBe(true)
    expect(trigger.textContent).toContain("Pick a location first")
    expect(
      apiMock.mock.calls.some(([p]) => String(p).startsWith("/api/rooms/"))
    ).toBe(false)
  })

  it("lists the location's rooms as their badges and picks one", async () => {
    wrap(<PickerHarness initial="l1" />)
    fireEvent.click(within(field("Room")).getByRole("combobox"))
    const option = await screen.findByText("Comms 210")
    expect(option.closest("[data-slot=badge]")).not.toBeNull()
    fireEvent.click(option)
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("rm1")
    )
  })
})
