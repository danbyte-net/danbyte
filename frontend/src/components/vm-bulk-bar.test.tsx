// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { VirtualMachine } from "@/lib/api"
import { VmBulkBar } from "./vm-bulk-bar"

// The VM list's selection bar: Edit renders the fields the server names in
// `bulk-edit-fields/`, the VM custom fields among them, and sends only what
// was armed to `bulk-update/`.

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
  custom_fields: "virtualmachine",
  fields: [
    {
      key: "description",
      label: "Description",
      kind: "text",
      nullable: false,
    },
  ],
}

const CUSTOM_FIELDS = {
  count: 2,
  next: null,
  previous: null,
  results: [
    {
      id: "cf1",
      key: "owner",
      label: "Owner team",
      type: "text",
      hidden: false,
      choices: [],
      description: "",
    },
    {
      id: "cf2",
      key: "secret",
      label: "Secret",
      type: "text",
      hidden: true,
      choices: [],
      description: "",
    },
  ],
}

function answer(path: string): Promise<unknown> {
  if (path.endsWith("bulk-edit-fields/")) return Promise.resolve(FIELDS)
  if (path.endsWith("bulk-update/")) return Promise.resolve({ updated: 2 })
  if (path.startsWith("/api/custom-fields/"))
    return Promise.resolve(CUSTOM_FIELDS)
  if (path.startsWith("/api/customization/meta/"))
    return Promise.resolve({ models: [], reference_models: [] })
  return Promise.resolve({ count: 0, next: null, previous: null, results: [] })
}

const VMS = [{ id: "v1" }, { id: "v2" }] as VirtualMachine[]

function mount(props: { canEdit?: boolean; canDelete?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onCleared = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <VmBulkBar selected={VMS} onCleared={onCleared} {...props} />
    </QueryClientProvider>
  )
  return onCleared
}

describe("VmBulkBar", () => {
  it("edits the server's fields and custom fields, sending only what was set", async () => {
    apiMock.mockImplementation(answer)
    const onCleared = mount({ canEdit: true })
    fireEvent.click(screen.getByRole("button", { name: /Edit/ }))
    expect(await screen.findByText("Edit 2 virtual machines")).toBeTruthy()
    expect(await screen.findByText("Owner team")).toBeTruthy()
    // A hidden custom field is not offered.
    expect(screen.queryByText("Secret")).toBeNull()
    expect(screen.getByText("Add tags")).toBeTruthy()
    // Arm the custom field only; the description is kept.
    const [, owner] = screen.getAllByRole("checkbox")
    fireEvent.click(owner)
    const [, ownerInput] = screen.getAllByRole("textbox")
    fireEvent.change(ownerInput, { target: { value: "net" } })
    fireEvent.click(screen.getByRole("button", { name: "Apply to 2" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    const call = apiMock.mock.calls.find(([p]) => p.endsWith("bulk-update/"))!
    expect(call[0]).toBe("/api/virtual-machines/bulk-update/")
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      ids: ["v1", "v2"],
      fields: { custom_fields: { owner: "net" } },
    })
    expect(toastMock.success).toHaveBeenCalledWith("Updated 2 virtual machines")
  })

  it("leaves out what the caller may not do", () => {
    mount({ canDelete: true })
    expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull()
    expect(screen.getByRole("button", { name: /Delete/ })).toBeTruthy()
  })
})
