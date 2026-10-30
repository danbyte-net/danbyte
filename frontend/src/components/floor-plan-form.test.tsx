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
import { FloorPlanForm } from "./floor-plan-form"

// A floor plan names a site and, optionally, a location: left at "Whole
// site" it is a site-wide plan.

const { apiMock, saveMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  saveMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: (path: string) => apiMock(path),
}))
vi.mock("@/lib/save-object", () => ({
  useSaveObject: () => saveMock,
  usePlanTarget: () => null,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
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

const page = <T,>(results: T[]) => ({
  count: results.length,
  next: null,
  results,
})

beforeEach(() => {
  apiMock.mockReset()
  saveMock.mockReset()
  saveMock.mockResolvedValue({ id: "p1", name: "Campus" })
  apiMock.mockImplementation((path) => {
    if (path === "/api/sites/")
      return Promise.resolve(page([{ id: "s1", name: "Campus" }]))
    if (path.startsWith("/api/locations/?picker=1&site=s1"))
      return Promise.resolve(
        page([{ id: "l1", name: "Building A", slug: "building-a" }])
      )
    if (path === "/api/locations/l1/")
      return Promise.resolve({
        id: "l1",
        name: "Building A",
        site: { id: "s1", name: "Campus" },
      })
    return Promise.resolve(page([]))
  })
})
afterEach(cleanup)

function mount(props: Partial<Parameters<typeof FloorPlanForm>[0]> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <FloorPlanForm onSaved={() => {}} onCancel={() => {}} {...props} />
    </QueryClientProvider>
  )
}

describe("the new floor plan form", () => {
  it("makes a site-wide plan when the location is left at Whole site", async () => {
    mount({ initialSiteId: "s1" })
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Campus" },
    })
    expect(
      screen.getByRole("combobox", { name: /Location/ }).textContent
    ).toContain("Whole site")
    fireEvent.click(screen.getByRole("button", { name: "Create floor plan" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const { payload } = saveMock.mock.calls[0][0]
    expect(payload.site_id).toBe("s1")
    expect(payload.location_id).toBeNull()
  })

  it("takes the site from a location picked on a Location page", async () => {
    mount({ initialLocationId: "l1" })
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "Hall" },
    })
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: /Site/ }).textContent
      ).toContain("Campus")
    )
    fireEvent.click(screen.getByRole("button", { name: "Create floor plan" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const { payload } = saveMock.mock.calls[0][0]
    expect(payload.site_id).toBe("s1")
    expect(payload.location_id).toBe("l1")
  })
})
