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
import type { Tunnel, TunnelWritePayload } from "@/lib/api"
import { TunnelForm } from "./tunnel-form"

// A tunnel's capacity (#246) is typed as a speed - "500M", "1G" - and
// stored in kbps; the site map shows it on the tunnel's line. Something
// that is not a speed is refused in the form rather than saved as a guess.

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
        ...TUNNEL,
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/dcim/choices/")
      return Promise.resolve({ common_speeds: ["100M", "1G", "10G"] })
    return page([])
  })
})
afterEach(cleanup)

const TUNNEL = {
  id: "t1",
  numid: 1,
  name: "hq-branch",
  status: null,
  encapsulation: "gre",
  encapsulation_display: "GRE",
  tunnel_id: null,
  group: null,
  ipsec_profile: null,
  terminations: [],
  capacity_kbps: 500_000,
  description: "",
  comments: "",
  tags: [],
  custom_fields: {},
  created_at: "",
  updated_at: "",
} as unknown as Tunnel

function renderForm(tunnel?: Tunnel) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <TunnelForm tunnel={tunnel} onSaved={onSaved} onCancel={() => {}} />
    </QueryClientProvider>
  )
  return { onSaved }
}

function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}
const capacity = () =>
  within(field("Capacity")).getByRole<HTMLInputElement>("combobox")

function submit() {
  const button = screen.getByRole("button", { name: /Create tunnel|Save/ })
  fireEvent.submit(button.closest("form") as HTMLFormElement)
}

function sent(): TunnelWritePayload {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as TunnelWritePayload
}

describe("TunnelForm capacity", () => {
  it("shows the stored figure as a speed and sends a typed one in kbps", async () => {
    const { onSaved } = renderForm(TUNNEL)
    await waitFor(() => expect(capacity().value).toBe("500M"))
    fireEvent.change(capacity(), { target: { value: "1G" } })
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent().capacity_kbps).toBe(1_000_000)
  })

  it("keeps a figure the short form rounds when the field is left alone", async () => {
    const { onSaved } = renderForm({ ...TUNNEL, capacity_kbps: 1_234_567 })
    await waitFor(() => expect(capacity().value).toBe("1.23457G"))
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent().capacity_kbps).toBe(1_234_567)
  })

  it("sends null when the field is cleared", async () => {
    const { onSaved } = renderForm(TUNNEL)
    await waitFor(() => expect(capacity().value).toBe("500M"))
    fireEvent.change(capacity(), { target: { value: "" } })
    submit()
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(sent().capacity_kbps).toBeNull()
  })

  it("refuses text that is not a speed, and saves nothing", async () => {
    const { onSaved } = renderForm(TUNNEL)
    await waitFor(() => expect(capacity().value).toBe("500M"))
    fireEvent.change(capacity(), { target: { value: "fast" } })
    submit()
    expect(
      await screen.findByText("Enter a speed, such as 500M or 1G.")
    ).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()
    expect(
      apiMock.mock.calls.some(
        ([, init]) => init?.method === "POST" || init?.method === "PATCH"
      )
    ).toBe(false)
  })
})
