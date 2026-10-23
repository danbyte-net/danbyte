// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { MaintenanceEvent } from "@/lib/api"
import { MaintenanceEventForm, impactSummary } from "./maintenance-event-form"
import type { InitialImpact } from "./maintenance-event-form"

// "Plan maintenance" on a power or cooling source (#434) opens the form with
// the source's derived impacts; a create sends them along, an edit never does.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

const IMPACTS: InitialImpact[] = [
  { object_type: "coolingsource", object_id: "s1", level: "outage" },
  { object_type: "coolingfeed", object_id: "f1", level: "outage" },
  { object_type: "coolingfeed", object_id: "f2", level: "outage" },
  { object_type: "rack", object_id: "r1", level: "outage" },
  { object_type: "rack", object_id: "r2", level: "reduced_redundancy" },
  { object_type: "device", object_id: "d1", level: "reduced_redundancy" },
]

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({ id: "e-new" })
    if (path.startsWith("/api/statuses/"))
      return page([
        {
          id: "st1",
          name: "Tentative",
          color: "#888888",
          default_for: ["maintenanceevent"],
        },
      ])
    return page([])
  })
})
afterEach(cleanup)

function renderForm(props: {
  event?: MaintenanceEvent
  initialImpacts?: InitialImpact[]
  initialName?: string
}) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const { container } = render(
    <QueryClientProvider client={qc}>
      <MaintenanceEventForm {...props} onSaved={onSaved} onCancel={() => {}} />
    </QueryClientProvider>
  )
  return { onSaved, form: container.querySelector("form")! }
}

function sent(): { method: string; body: Record<string, unknown> } {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return {
    method: String(call[1]?.method),
    body: JSON.parse(String(call[1]?.body)) as Record<string, unknown>,
  }
}

describe("impactSummary", () => {
  it("counts per object type, feeds of a kind together", () => {
    expect(impactSummary(IMPACTS)).toBe(
      "1 cooling source, 2 feeds, 2 racks, 1 device"
    )
  })
})

describe("MaintenanceEventForm impacts", () => {
  it("sends the prefilled impacts on create", async () => {
    const { onSaved, form } = renderForm({
      initialImpacts: IMPACTS,
      initialName: "Maintenance on CH-1",
    })
    expect(screen.getByDisplayValue("Maintenance on CH-1")).toBeTruthy()
    expect(screen.getByTestId("impact-summary").textContent).toBe(
      "1 cooling source, 2 feeds, 2 racks, 1 device"
    )
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(([p]) => p.startsWith("/api/statuses/"))
      ).toBe(true)
    )
    fireEvent.submit(form)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const { method, body } = sent()
    expect(method).toBe("POST")
    expect(body.name).toBe("Maintenance on CH-1")
    expect(body.impacts).toEqual(IMPACTS)
  })

  it("drops them when asked", async () => {
    const { onSaved, form } = renderForm({
      initialImpacts: IMPACTS,
      initialName: "x",
    })
    fireEvent.click(screen.getByRole("button", { name: /Drop/ }))
    expect(screen.queryByTestId("impact-summary")).toBeNull()
    fireEvent.submit(form)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent().body).not.toHaveProperty("impacts")
  })

  it("never sends impacts on edit", async () => {
    const event = {
      id: "e1",
      kind: "maintenance",
      status: { id: "st1" },
      name: "Existing",
      description: "",
      provider: null,
      external_ref: "",
      starts_at: "2026-10-23T10:00:00Z",
      ends_at: "2026-10-23T12:00:00Z",
      etr: null,
      impacts: [],
    } as unknown as MaintenanceEvent
    const { onSaved, form } = renderForm({ event, initialImpacts: IMPACTS })
    expect(screen.queryByTestId("impact-summary")).toBeNull()
    fireEvent.submit(form)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    const { method, body } = sent()
    expect(method).toBe("PATCH")
    expect(body).not.toHaveProperty("impacts")
  })
})
