// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { SafeBulkEditBar } from "./safe-bulk-edit-bar"

// The routing lists' selection bar (#314): Edit renders the fields the
// server names in `bulk-edit-fields/` and sends only what was set to
// `bulk-update/`; Delete is the safe bulk delete with its preview.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

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

const FIELDS = {
  tags: true,
  fields: [
    {
      key: "description",
      label: "Description",
      kind: "text",
      nullable: false,
    },
    {
      key: "keychain_id",
      label: "Keychain",
      kind: "object",
      nullable: true,
      object_model: "routingkeychain",
      endpoint: "/api/routing/keychains/",
    },
  ],
}

function mount(props: { canEdit?: boolean; canDelete?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onCleared = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <SafeBulkEditBar
        selected={[{ id: "s1" }, { id: "s2" }]}
        endpoint="/api/routing/bgp-sessions/"
        noun={["BGP session", "BGP sessions"]}
        invalidate={[["bgp-sessions"]]}
        onCleared={onCleared}
        {...props}
      />
    </QueryClientProvider>
  )
  return onCleared
}

describe("SafeBulkEditBar", () => {
  it("edits the fields the server names and sends only what was set", async () => {
    apiMock.mockImplementation((path) => {
      if (path.endsWith("bulk-edit-fields/")) return Promise.resolve(FIELDS)
      if (path.endsWith("bulk-update/")) return Promise.resolve({ updated: 2 })
      return Promise.resolve({ results: [] })
    })
    const onCleared = mount()
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    expect(await screen.findByText("Edit 2 BGP sessions")).toBeTruthy()
    expect(await screen.findByText("Keychain")).toBeTruthy()
    expect(screen.getByText("Add tags")).toBeTruthy()
    // Arm the description, then clear the keychain.
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "core" },
    })
    fireEvent.click(screen.getByText("Keep current"))
    fireEvent.click(await screen.findByText("Clear keychain"))
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    const call = apiMock.mock.calls.find(([p]) => p.endsWith("bulk-update/"))!
    expect(call[0]).toBe("/api/routing/bgp-sessions/bulk-update/")
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      ids: ["s1", "s2"],
      fields: { description: "core", keychain_id: null },
    })
    expect(toastMock.success).toHaveBeenCalledWith("Updated 2 BGP sessions")
  })

  it("previews a delete and names the rows kept", async () => {
    apiMock.mockResolvedValue({
      deleted: 1,
      deleted_ids: ["s2"],
      skipped: [{ id: "s1", name: "EDGE", reason: "In use: 2 BGP sessions." }],
      impact: [],
      released: [],
      dry_run: true,
    })
    mount()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("In use: 2 BGP sessions.")).toBeTruthy()
    expect(apiMock.mock.calls[0][0]).toBe(
      "/api/routing/bgp-sessions/bulk-delete/"
    )
  })

  it("leaves out what the caller may not do", () => {
    mount({ canEdit: false })
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy()
  })
})
