// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SafeBulkDeleteBar } from "./safe-bulk-delete-bar"
import type { SafeBulkDeleteResult } from "./safe-bulk-delete-bar"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", () => ({ api: apiMock }))

afterEach(cleanup)

const answer = (o: Partial<SafeBulkDeleteResult>): SafeBulkDeleteResult => ({
  deleted: 1,
  deleted_ids: ["a"],
  skipped: [],
  impact: [],
  released: [],
  dry_run: true,
  ...o,
})

function renderBar(
  extra: Partial<Parameters<typeof SafeBulkDeleteBar>[0]> = {}
) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const onCleared = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <SafeBulkDeleteBar
        selected={[{ id: "a" }, { id: "b" }]}
        endpoint="/api/virtual-chassis/"
        noun={["virtual chassis", "virtual chassis"]}
        invalidate={[["virtual-chassis"]]}
        onCleared={onCleared}
        {...extra}
      />
    </QueryClientProvider>
  )
  return onCleared
}

describe("SafeBulkDeleteBar", () => {
  beforeEach(() => apiMock.mockReset())

  it("asks first what would go, what is released and what is kept", async () => {
    apiMock.mockResolvedValueOnce(
      answer({
        released: [{ label: "member devices", count: 3 }],
        skipped: [{ id: "b", name: "stack-2", reason: "In use: 1 circuit." }],
      })
    )
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("3 member devices")).toBeTruthy()
    expect(screen.getByText("stack-2")).toBeTruthy()
    const [url, init] = apiMock.mock.calls[0]
    expect(url).toBe("/api/virtual-chassis/bulk-delete/")
    expect(JSON.parse(String(init?.body))).toEqual({
      ids: ["a", "b"],
      dry_run: true,
    })
    expect(screen.getByRole("button", { name: "Delete 1" })).toBeTruthy()
  })

  it("deletes for real, then clears the selection", async () => {
    apiMock
      .mockResolvedValueOnce(answer({}))
      .mockResolvedValueOnce(answer({ dry_run: false }))
    const onCleared = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete 1" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[1][1]?.body))).toEqual({
      ids: ["a", "b"],
    })
  })

  it("carries extra actions, and Delete only when allowed", () => {
    renderBar({
      actions: <button type="button">Edit</button>,
      canDelete: false,
    })
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull()
  })
})
