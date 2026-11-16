// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FilterSnapshot } from "@/components/table-filters"

import { SavedViews } from "./saved-views"
import type { SavedView } from "./saved-views"

// A list's pinned view (#523): opened bare, the list applies it; a link with
// filters wins; "Show all" opens it unfiltered once.
const calls: { url: string; init?: RequestInit }[] = []
let views: SavedView[] = []
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.includes("/pin/")) return views[0]
    return { count: views.length, next: null, previous: null, results: views }
  }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
let admin = false
vi.mock("@/lib/use-me", () => ({ useMe: () => ({ canManage: admin }) }))

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.hasPointerCapture = () => false
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
})
afterEach(() => {
  cleanup()
  calls.length = 0
  views = []
  admin = false
})

function view(over: Partial<SavedView>): SavedView {
  return {
    id: "v1",
    object_type: "device",
    name: "Core switches",
    description: "",
    query: { q: "sw", facets: { role: ["core"] } },
    shared: false,
    owner: "me",
    mine: true,
    is_default: false,
    is_tenant_default: false,
    ...over,
  }
}

/** A list's filter state, as the page holds it. */
function Harness({
  initial,
}: {
  initial?: { q?: string; facets?: FilterSnapshot }
}) {
  const [q, setQ] = useState(initial?.q ?? "")
  const [facets, setFacets] = useState<FilterSnapshot>(initial?.facets ?? {})
  const active = Object.values(facets).filter(
    (v) => Array.isArray(v) && v.length
  ).length
  return (
    <>
      <span data-testid="state">{JSON.stringify({ q, facets })}</span>
      <SavedViews
        objectType="device"
        q={q}
        onQ={setQ}
        filters={{
          snapshot: () => facets,
          restore: (s) => setFacets(s ?? {}),
          activeCount: active,
        }}
      />
    </>
  )
}

function mount(initial?: { q?: string; facets?: FilterSnapshot }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <Harness initial={initial} />
    </QueryClientProvider>
  )
}

const state = () => JSON.parse(screen.getByTestId("state").textContent)

describe("a list's pinned view", () => {
  it("opens a bare list with your pinned view, and Show all clears it", async () => {
    views = [view({ is_default: true })]
    mount()
    await waitFor(() =>
      expect(state()).toEqual({ q: "sw", facets: { role: ["core"] } })
    )
    const chip = await screen.findByTestId("default-view-chip")
    expect(chip.textContent).toContain("Core switches")
    fireEvent.click(screen.getByRole("button", { name: "Show all" }))
    expect(state()).toEqual({ q: "", facets: {} })
    expect(screen.queryByTestId("default-view-chip")).toBeNull()
  })

  it("leaves a link with filters alone", async () => {
    views = [view({ is_default: true })]
    mount({ facets: { site: ["s1"] } })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(state()).toEqual({ q: "", facets: { site: ["s1"] } })
    expect(screen.queryByTestId("default-view-chip")).toBeNull()
  })

  it("leaves a link with a search alone", async () => {
    views = [view({ is_default: true })]
    mount({ q: "rtr" })
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(state().q).toBe("rtr")
  })

  it("takes yours over the tenant's", async () => {
    views = [
      view({
        id: "t",
        name: "Everyone",
        is_tenant_default: true,
        shared: true,
        query: { facets: { site: ["hq"] } },
      }),
      view({ id: "m", name: "Mine", is_default: true }),
    ]
    mount()
    await waitFor(() => expect(state().q).toBe("sw"))
    expect(screen.getByTestId("default-view-chip").textContent).toContain(
      "Mine"
    )
  })

  it("falls back to the tenant's pin", async () => {
    views = [
      view({
        id: "t",
        name: "Everyone",
        mine: false,
        shared: true,
        is_tenant_default: true,
        query: { facets: { site: ["hq"] } },
      }),
    ]
    mount()
    await waitFor(() => expect(state().facets).toEqual({ site: ["hq"] }))
  })

  it("does nothing without a pin", async () => {
    views = [view({})]
    mount()
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    await act(async () => {})
    expect(state()).toEqual({ q: "", facets: {} })
  })

  it("pins a view for you from the menu", async () => {
    views = [view({})]
    mount()
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    fireEvent.click(
      await screen.findByRole("button", { name: "Pin “Core switches”" })
    )
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes("/pin/"))).toBe(true)
    )
    const pin = calls.find((c) => c.url.includes("/pin/"))!
    expect(pin.url).toBe("/api/saved-filters/v1/pin/")
    expect(pin.init?.method).toBe("POST")
    expect(JSON.parse(String(pin.init?.body))).toEqual({ scope: "me" })
  })

  it("offers pinning for everyone to administrators, on shared views", async () => {
    views = [view({ shared: true })]
    mount()
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    await screen.findByRole("button", { name: "Pin “Core switches”" })
    expect(screen.queryByRole("button", { name: /More for/ })).toBeNull()
    cleanup()
    admin = true
    views = [view({ shared: true })]
    mount()
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    expect(
      await screen.findByRole("button", { name: "More for “Core switches”" })
    ).toBeTruthy()
  })
})
