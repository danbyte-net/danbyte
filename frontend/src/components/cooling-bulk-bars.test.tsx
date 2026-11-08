// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CoolingFeedBulkBar, CoolingSourceBulkBar } from "./cooling-bulk-bars"

// The cooling lists' selection bars (#434): the safe delete with Edit beside
// it, and a source's "delete their feeds too" only for who may delete feeds.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path.includes("bulk-delete")
        ? {
            deleted: 0,
            deleted_ids: [],
            skipped: [
              { id: "c1", name: "CRAH-1", reason: "In use: 2 cooling feeds." },
            ],
            impact: [],
            released: [],
            notes: [],
            dry_run: true,
          }
        : { count: 0, results: [] }
    )
  )
})

const selected = [
  { id: "c1", name: "CRAH-1" },
  { id: "c2", name: "CRAH-2" },
]

function mount(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

describe("CoolingFeedBulkBar", () => {
  it("opens the bulk edit for the selection", async () => {
    mount(
      <CoolingFeedBulkBar
        selected={selected}
        onCleared={vi.fn()}
        canEdit
        canDelete
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(await screen.findByText("Edit 2 cooling feeds")).toBeTruthy()
    expect(screen.getByText("Max utilization")).toBeTruthy()
    expect(screen.getByText("Cooling source")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Apply to 2" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("offers Edit and Delete only as allowed", () => {
    mount(
      <CoolingFeedBulkBar
        selected={selected}
        onCleared={vi.fn()}
        canEdit={false}
        canDelete={false}
      />
    )
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull()
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull()
  })
})

describe("CoolingSourceBulkBar", () => {
  it("edits the unit's fields", async () => {
    mount(
      <CoolingSourceBulkBar
        selected={selected}
        onCleared={vi.fn()}
        canEdit
        canDelete
        canDeleteFeeds
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    expect(await screen.findByText("Edit 2 cooling sources")).toBeTruthy()
    expect(screen.getByText("Fluid")).toBeTruthy()
    expect(screen.getByText("Redundancy group")).toBeTruthy()
  })

  it("offers to delete the feeds too to who may delete feeds", async () => {
    mount(
      <CoolingSourceBulkBar
        selected={selected}
        onCleared={vi.fn()}
        canEdit
        canDelete
        canDeleteFeeds
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(
      await screen.findByRole("checkbox", { name: "Delete their feeds too" })
    ).toBeTruthy()
  })

  it("does not offer it otherwise", async () => {
    mount(
      <CoolingSourceBulkBar
        selected={selected}
        onCleared={vi.fn()}
        canEdit
        canDelete
        canDeleteFeeds={false}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("CRAH-1")).toBeTruthy()
    expect(screen.queryByText("Delete their feeds too")).toBeNull()
  })
})
