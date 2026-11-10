// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { NO_FILTER } from "./plan-filter"
import type { PlanFilter } from "./plan-filter"
import { PlanFilterMenu } from "./plan-filter-menu"

// The floor plan's Filter, saved Views and chip: the saved views are the
// lists' (/api/saved-filters/), under the `floorplan` object type.

const calls: { url: string; init?: RequestInit }[] = []
let views: unknown[] = []
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  api: vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (init?.method === "POST")
      return {
        id: "v1",
        mine: true,
        shared: false,
        owner: "me",
        description: "",
        ...JSON.parse(String(init.body)),
      }
    return { count: views.length, next: null, previous: null, results: views }
  }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

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
})

const AP = { id: "ap", name: "AP", color: "#0ea5e9", icon: "wifi" }
const tiles = [
  {
    id: "t1",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    tile_type: null,
    role_type: null,
    status: "",
    linked: { kind: "device", id: "d1", name: "ap-1", role: AP },
  },
] as unknown as FloorPlanTile[]

function menu(filter: PlanFilter, onChange = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PlanFilterMenu
        filter={filter}
        onChange={onChange}
        tiles={tiles}
        areas={[]}
        kept={filter === NO_FILTER ? null : 1}
      />
    </QueryClientProvider>
  )
  return onChange
}

const apsOnly: PlanFilter = { facets: { role: ["ap"] }, expr: "", hide: false }

describe("the floor plan's saved views", () => {
  it("suggests saving one when there are none", async () => {
    menu(NO_FILTER)
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    expect(
      await screen.findByText(/Filter the plan - only the access points/)
    ).toBeTruthy()
    expect(calls[0].url).toContain("object_type=floorplan")
  })

  it("saves the filter as a view of the floorplan type", async () => {
    menu(apsOnly)
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    fireEvent.click(await screen.findByText("Save current filters"))
    fireEvent.change(screen.getByPlaceholderText("Name this view"), {
      target: { value: "APs" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save view" }))
    await waitFor(() =>
      expect(calls.some((c) => c.init?.method === "POST")).toBe(true)
    )
    const post = calls.find((c) => c.init?.method === "POST")!
    expect(post.url).toBe("/api/saved-filters/")
    expect(JSON.parse(String(post.init!.body))).toEqual({
      object_type: "floorplan",
      name: "APs",
      shared: false,
      query: { q: "", facets: { role: ["ap"] } },
    })
  })

  it("applies a saved view, its Hide others too", async () => {
    views = [
      {
        id: "v2",
        object_type: "floorplan",
        name: "Access points",
        description: "",
        query: { q: "", facets: { role: ["ap"], hide: "1" } },
        shared: true,
        owner: "anna",
        mine: false,
      },
    ]
    const onChange = menu(NO_FILTER)
    fireEvent.click(screen.getByRole("button", { name: /Views/ }))
    fireEvent.click(await screen.findByText("Access points"))
    expect(onChange).toHaveBeenCalledWith({
      facets: { role: ["ap"] },
      expr: "",
      hide: true,
    })
  })
})

describe("the filter's chip", () => {
  it("says what it keeps and clears it", () => {
    const onChange = menu(apsOnly)
    expect(document.body.textContent).toContain("AP · 1 shown")
    fireEvent.click(screen.getByRole("button", { name: "Clear" }))
    expect(onChange).toHaveBeenCalledWith(NO_FILTER)
  })
})
