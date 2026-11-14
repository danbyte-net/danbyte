// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { DeviceDependencyDialog } from "./dependency-dialog"

// The add dialog (#450): the server refuses a cycle with its path, and the
// dialog shows it - under the picker for one device, as a list naming each
// refused device when several were picked.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: async () => ({ count: 0, results: [] }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Not planning: no `plan` in the location.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => ({}),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: () => true }),
}))
// The device picker as two buttons that hand over picked devices.
vi.mock("@/components/device-picker", () => ({
  DevicePicker: ({
    label,
    error,
    onPickMany,
  }: {
    label: string
    error?: string
    onPickMany?: (items: { id: string; label: string }[]) => void
  }) => (
    <div>
      <span>{label}</span>
      <button
        type="button"
        onClick={() => onPickMany?.([{ id: "d2", label: "acc-7" }])}
      >
        pick one
      </button>
      <button
        type="button"
        onClick={() =>
          onPickMany?.([
            { id: "d2", label: "acc-7" },
            { id: "d3", label: "acc-8" },
          ])
        }
      >
        pick two
      </button>
      {error && <p>{error}</p>}
    </div>
  ),
}))

const CYCLE = "This would make a cycle: core-1 → dist-2 → acc-7 → core-1."

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(cleanup)

function renderDialog() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DeviceDependencyDialog
        mode={{
          kind: "add",
          anchor: { device: { id: "d1", name: "core-1" }, as: "downstream" },
        }}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>
  )
}

async function refuseCycle() {
  const { ApiError } = await vi.importActual<typeof Api>("@/lib/api")
  return new ApiError(400, { upstream_id: [CYCLE] })
}

describe("DeviceDependencyDialog", () => {
  it("shows a refused cycle under the picker", async () => {
    const err = await refuseCycle()
    apiMock.mockRejectedValue(err)
    renderDialog()
    expect(screen.getByText("Add upstream of core-1")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "pick one" }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    expect(await screen.findByText(CYCLE)).toBeTruthy()
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/device-dependencies/")
    expect(JSON.parse(String(init?.body))).toMatchObject({
      upstream_id: "d2",
      downstream_id: "d1",
      kind: "dependency",
    })
  })

  it("names each refused device when several were picked", async () => {
    const err = await refuseCycle()
    apiMock.mockImplementation(async (_path, init) => {
      if (JSON.parse(String(init?.body)).upstream_id === "d2") throw err
      return { id: "x" }
    })
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "pick two" }))
    fireEvent.click(screen.getByRole("button", { name: "Add" }))
    const alert = await screen.findByRole("alert")
    expect(alert.textContent).toBe(`acc-7: ${CYCLE}`)
    // The saved device leaves the list; the refused one stays to retry.
    expect(screen.getByRole("button", { name: "Remove acc-7" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Remove acc-8" })).toBeNull()
  })
})
