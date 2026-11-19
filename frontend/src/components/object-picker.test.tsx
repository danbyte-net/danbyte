// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { DevicePicker } from "./device-picker"

// A device picker on a tenant of 50,000 devices walked the whole list (10
// requests of 1,000) on mount, on every page that showed one (#534). It
// loads one page when opened now, and searches the server as you type.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}

afterEach(cleanup)

const page = <T,>(results: T[], count = results.length) => ({
  count,
  next: null,
  previous: null,
  results,
})

function renderPicker(value: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DevicePicker value={value} onChange={() => {}} />
    </QueryClientProvider>
  )
}

describe("ObjectPicker server search", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/api/devices/?picker=1")) {
        const q = new URL(path, "http://x").searchParams.get("search")
        return Promise.resolve(
          q
            ? page([{ id: "d9", name: `found-${q}` }], 1)
            : page([{ id: "d1", name: "sw-001" }], 50000)
        )
      }
      if (path === "/api/devices/d7/")
        return Promise.resolve({ id: "d7", name: "picked-before" })
      return new Promise(() => {})
    })
  })
  afterEach(() => vi.useRealTimers())

  it("fetches nothing until the list opens, then one page", async () => {
    renderPicker()
    expect(apiMock).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("combobox"))
    expect(await screen.findByText("sw-001")).toBeTruthy()
    const calls = apiMock.mock.calls.map((c) => c[0])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("page_size=50")
    expect(calls[0]).not.toContain("page_size=1000")
  })

  it("searches the server for what is typed", async () => {
    renderPicker()
    fireEvent.click(screen.getByRole("combobox"))
    await screen.findByText("sw-001")
    const box = screen.getByPlaceholderText("Search devices…")
    fireEvent.change(box, { target: { value: "core-9" } })
    await act(async () => {
      vi.advanceTimersByTime(300)
    })
    expect(await screen.findByText("found-core-9")).toBeTruthy()
    expect(
      apiMock.mock.calls.some((c) => String(c[0]).includes("search=core-9"))
    ).toBe(true)
  })

  it("names a value it has not listed from the object itself", async () => {
    renderPicker("d7")
    expect(await screen.findByText("picked-before")).toBeTruthy()
    expect(apiMock.mock.calls.map((c) => c[0])).toEqual(["/api/devices/d7/"])
  })
})
