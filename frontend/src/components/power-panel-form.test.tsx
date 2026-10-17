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
import type { PowerPanel } from "@/lib/api"
import { PowerPanelForm } from "./power-panel-form"

// A panel's location is picked from the chosen site's locations only, and a
// new site clears it - the server refuses a location outside the site.

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

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({
        id: "p-new",
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/sites/")
      return page([
        { id: "s1", name: "HQ" },
        { id: "s2", name: "DR" },
      ])
    if (path === "/api/locations/?picker=1&site=s1")
      return page([{ id: "l1", name: "Hall A" }])
    if (path === "/api/locations/?picker=1&site=s2")
      return page([{ id: "l9", name: "Vault" }])
    return page([])
  })
})
afterEach(cleanup)

function renderForm(panel?: PowerPanel) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <PowerPanelForm panel={panel} onSaved={onSaved} onCancel={() => {}} />
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

function sent(): Record<string, unknown> {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
}

describe("PowerPanelForm location", () => {
  it("offers the site's locations and sends the picked one", async () => {
    const { onSaved } = renderForm()
    fireEvent.change(within(field("Name")).getByRole("textbox"), {
      target: { value: "MDB-1" },
    })
    await pick("Site", "HQ")
    await pick("Location", "Hall A")
    fireEvent.submit(
      screen.getByRole("button", { name: "Create panel" }).closest("form")!
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toMatchObject({
      name: "MDB-1",
      site_id: "s1",
      location_id: "l1",
    })
  })

  it("clears the location when the site changes", async () => {
    const panel = {
      id: "p1",
      numid: 1,
      name: "MDB-1",
      site: { id: "s1", name: "HQ" },
      location: { id: "l1", name: "Hall A" },
      comments: "",
      feed_count: 0,
      tags: [],
      custom_fields: {},
      created_at: "",
      updated_at: "",
    } as unknown as PowerPanel
    const { onSaved } = renderForm(panel)
    await pick("Site", "DR")
    fireEvent.submit(
      screen.getByRole("button", { name: "Save changes" }).closest("form")!
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent()).toMatchObject({ site_id: "s2", location_id: null })
  })
})
