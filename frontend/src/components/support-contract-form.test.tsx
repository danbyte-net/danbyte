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
import type { SupportContract } from "@/lib/api"
import { SupportContractForm } from "./support-contract-form"

// The support contract form (#421) sends what is in its fields: a blank cost
// is null, a currency is upper-cased, dates left empty are null (an empty
// end date means open-ended), and the ticked channels go as ids. Without
// view_cost the cost fields are neither shown nor sent.

const { apiMock, perms } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  perms: { viewCost: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: {},
    canDo: (_type: string, action: string) =>
      action === "view_cost" ? perms.viewCost : true,
    humanIds: false,
  }),
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
  perms.viewCost = true
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method === "POST" || init?.method === "PATCH")
      return Promise.resolve({
        id: "k-new",
        contract_number: "X",
        ...(JSON.parse(String(init.body)) as object),
      })
    if (path === "/api/manufacturers/?picker=1")
      return page([{ id: "m1", name: "Cisco" }])
    if (path.startsWith("/api/monitoring/channels/"))
      return page([{ id: "ch1", name: "NOC mail", kind: "email" }])
    return page([])
  })
})
afterEach(cleanup)

function renderForm(contract?: SupportContract) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <SupportContractForm
        contract={contract}
        onSaved={onSaved}
        onCancel={() => {}}
      />
    </QueryClientProvider>
  )
  return { onSaved }
}

function field(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: "label" }).closest("div.grid")
  if (!(el instanceof HTMLElement)) throw new Error(`no field ${label}`)
  return el
}
const input = (label: string) =>
  within(field(label)).getByRole<HTMLInputElement>(
    label === "Cost" ? "spinbutton" : "textbox"
  )

function sent(): Record<string, unknown> {
  const call = apiMock.mock.calls.find(
    ([, init]) => init?.method === "POST" || init?.method === "PATCH"
  )
  if (!call) throw new Error("nothing was sent")
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>
}

const CONTRACT: SupportContract = {
  id: "k1",
  numid: 3,
  manufacturer: { id: "m1", name: "Cisco" },
  contract_number: "SN-100",
  service_level: "8x5xNBD",
  start_date: "2026-01-01",
  end_date: "2027-01-01",
  state: "active",
  reseller: "Acme",
  cost: 1200,
  currency: "EUR",
  portal_url: "https://vendor.example.com",
  renewal_notes: "",
  description: "",
  notify_channels: [{ id: "ch1", name: "NOC mail" }],
  device_count: 2,
  tags: [],
  custom_fields: {},
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
}

describe("SupportContractForm", () => {
  it("sends a new contract with blanks as null and the currency upper-cased", async () => {
    renderForm()
    fireEvent.click(within(field("Manufacturer")).getByRole("combobox"))
    fireEvent.click(await screen.findByText("Cisco"))
    fireEvent.change(input("Contract number"), {
      target: { value: " SN-9 " },
    })
    fireEvent.change(input("Currency"), { target: { value: "eur" } })
    fireEvent.click(await screen.findByText("NOC mail"))
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Create contract" })
        .closest("form") as HTMLFormElement
    )
    await waitFor(() => expect(sent()).toBeTruthy())
    const body = sent()
    expect(body.manufacturer_id).toBe("m1")
    expect(body.contract_number).toBe("SN-9")
    expect(body.currency).toBe("EUR")
    expect(body.cost).toBeNull()
    expect(body.start_date).toBeNull()
    expect(body.end_date).toBeNull()
    expect(body.notify_channel_ids).toEqual(["ch1"])
    const call = apiMock.mock.calls.find(([, i]) => i?.method === "POST")
    expect(call?.[0]).toBe("/api/support-contracts/")
  })

  it("edits an existing contract in place", async () => {
    renderForm(CONTRACT)
    expect(input("Contract number").value).toBe("SN-100")
    fireEvent.change(input("Cost"), { target: { value: "1500.50" } })
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save changes" })
        .closest("form") as HTMLFormElement
    )
    await waitFor(() => expect(sent()).toBeTruthy())
    const call = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")
    expect(call?.[0]).toBe("/api/support-contracts/k1/")
    expect(sent().cost).toBe(1500.5)
    expect(sent().end_date).toBe("2027-01-01")
  })

  it("hides the cost and leaves it out of an edit without view_cost", async () => {
    perms.viewCost = false
    const { cost: _c, currency: _cur, ...hidden } = CONTRACT
    renderForm(hidden)
    expect(screen.queryByText("Cost", { selector: "label" })).toBeNull()
    expect(screen.queryByText("Currency", { selector: "label" })).toBeNull()
    fireEvent.change(input("Reseller"), { target: { value: "Other" } })
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save changes" })
        .closest("form") as HTMLFormElement
    )
    await waitFor(() => expect(sent()).toBeTruthy())
    expect(sent().reseller).toBe("Other")
    expect("cost" in sent()).toBe(false)
    expect("currency" in sent()).toBe(false)
  })
})
