// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import { ComponentBulkBar } from "./component-bulk-bar"

// The component bulk calls take 1000 ids (#286). Delete and Edit send a
// bigger selection in batches; rename and clone check names across the whole
// selection, so past 1000 they say so instead of running.

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: toastMock }))

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  toastMock.success.mockReset()
  toastMock.error.mockReset()
})

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `i${i}`, name: `eth${i}` }))

function mount(n: number) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const onCleared = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <ComponentBulkBar
        endpoint="/api/interfaces/"
        kindLabel="interface"
        selected={rows(n)}
        onCleared={onCleared}
        invalidate={[["device-interfaces"]]}
        fields={[{ key: "description", label: "Description", kind: "text" }]}
      />
    </QueryClientProvider>
  )
  return onCleared
}

/** The bulk calls so far: endpoint and how many ids each carried. */
const bulkCalls = () =>
  apiMock.mock.calls
    .filter(([path]) => path.includes("/bulk-"))
    .map(([path, init]) => {
      const body = JSON.parse(String(init?.body)) as {
        ids: string[]
        fields?: Record<string, unknown>
      }
      return { path, n: body.ids.length, fields: body.fields }
    })
const sizes = () => bulkCalls().map((c) => c.n)

describe("ComponentBulkBar over more rows than one call takes", () => {
  it("deletes in batches of 1000", async () => {
    apiMock.mockImplementation((_path, init) =>
      Promise.resolve({
        deleted: (JSON.parse(String(init?.body)) as { ids: string[] }).ids
          .length,
      })
    )
    const onCleared = mount(1500)
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(apiMock.mock.calls[0][0]).toBe("/api/interfaces/bulk-delete/")
    expect(sizes()).toEqual([1000, 500])
    expect(toastMock.success).toHaveBeenCalledWith("Deleted 1500")
  })

  it("stops a delete at a failed batch and says how far it got", async () => {
    apiMock
      .mockResolvedValueOnce({ deleted: 1000 })
      .mockRejectedValueOnce(new ApiError(500, { detail: "Server error." }))
    const onCleared = mount(2500)
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }))
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Deleted 1000 of 2500 interfaces.",
        { description: "Server error." }
      )
    )
    expect(sizes()).toEqual([1000, 1000])
    expect(onCleared).not.toHaveBeenCalled()
  })

  it("edits in batches, and keeps the dialog when one fails part-way", async () => {
    let updates = 0
    apiMock.mockImplementation((path) => {
      // The dialog's own lookups (choices) answer empty.
      if (!path.endsWith("bulk-update/")) return Promise.resolve({})
      updates += 1
      return updates === 1
        ? Promise.resolve({ updated: 1000 })
        : Promise.reject(new ApiError(500, { detail: "Server error." }))
    })
    const onCleared = mount(2500)
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    fireEvent.click(await screen.findByRole("checkbox"))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "uplink" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2500" }))
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Updated 1000 of 2500 interfaces.",
        { description: "Server error." }
      )
    )
    expect(bulkCalls()).toEqual([
      {
        path: "/api/interfaces/bulk-update/",
        n: 1000,
        fields: { description: "uplink" },
      },
      {
        path: "/api/interfaces/bulk-update/",
        n: 1000,
        fields: { description: "uplink" },
      },
    ])
    // Applying again is harmless, so the fields stay for another go.
    expect(screen.getByRole("button", { name: "Apply to 2500" })).toBeTruthy()
    expect(onCleared).not.toHaveBeenCalled()
  })

  it("holds rename and clone back past 1000 rows", async () => {
    mount(1001)
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }))
    fireEvent.change(await screen.findByPlaceholderText("text to find"), {
      target: { value: "eth" },
    })
    expect(screen.getByText("At most 1000 interfaces at a time.")).toBeTruthy()
    const rename = screen.getByRole("button", { name: "Rename 1001" })
    expect(rename.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    fireEvent.click(await screen.findByRole("button", { name: /Clone/ }))
    expect(
      await screen.findByText("At most 1000 interfaces at a time.")
    ).toBeTruthy()
    const clone = screen.getByRole("button", { name: "Clone 1001" })
    expect(clone.hasAttribute("disabled")).toBe(true)
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("renames 1000 rows in one call", async () => {
    apiMock.mockResolvedValue({ renamed: 1000 })
    const onCleared = mount(1000)
    fireEvent.click(screen.getByRole("button", { name: /Rename/ }))
    fireEvent.change(await screen.findByPlaceholderText("text to find"), {
      target: { value: "eth" },
    })
    expect(screen.queryByText(/at a time/)).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Rename 1000" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(apiMock.mock.calls[0][0]).toBe("/api/interfaces/bulk-rename/")
    expect(sizes()).toEqual([1000])
  })
})
