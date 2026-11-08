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
import type { LocationWritePayload } from "@/lib/api"
import { LocationForm } from "./location-form"

// A location can name its type - a catalog entry shown as its colour badge -
// and a short code. The "+" beside the Type picker makes a type without
// leaving the form and selects it.

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

let types: {
  id: string
  name: string
  slug: string
  color: string
  icon: string
}[]

beforeEach(() => {
  types = [
    {
      id: "lt-floor",
      name: "Floor",
      slug: "floor",
      color: "#a855f7",
      icon: "",
    },
  ]
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" && path === "/api/location-types/") {
      const body = JSON.parse(String(init.body)) as { name: string }
      const t = {
        id: "lt-new",
        name: body.name,
        slug: body.name.toLowerCase(),
        color: "",
        icon: "",
      }
      types = [...types, t]
      return Promise.resolve(t)
    }
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({
        id: "loc-new",
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/sites/") return page([{ id: "s1", name: "Campus" }])
    if (path === "/api/location-types/?picker=1") return page(types)
    return page([])
  })
})
afterEach(cleanup)

function renderForm() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onSaved = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <LocationForm onSaved={onSaved} onCancel={() => {}} />
    </QueryClientProvider>
  )
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

function sent(): LocationWritePayload {
  const call = apiMock.mock.calls.find(
    ([path, init]) => init?.method === "POST" && path === "/api/locations/"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as LocationWritePayload
}

function submit() {
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Create location" })
      .closest("form") as HTMLFormElement
  )
}

describe("LocationForm type and code", () => {
  it("sends the picked type and the code", async () => {
    const { onSaved } = renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "Building A" },
    })
    fireEvent.change(within(field("Code")).getByRole("textbox"), {
      target: { value: " A1 " },
    })
    await pick("Site", "Campus")
    await pick("Type", "Floor")
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      name: "Building A",
      code: "A1",
      site_id: "s1",
      location_type_id: "lt-floor",
    })
  })

  it("makes a type from the form and selects it", async () => {
    const { onSaved } = renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "Building B" },
    })
    await pick("Site", "Campus")
    fireEvent.click(
      within(field("Type")).getByRole("button", { name: "New location type" })
    )
    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getAllByRole("textbox")[0], {
      target: { value: "Building" },
    })
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(within(field("Type")).getByRole("combobox").textContent).toContain(
        "Building"
      )
    )
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent().location_type_id).toBe("lt-new")
  })
})
