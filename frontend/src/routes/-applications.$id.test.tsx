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
import { InstalledOn } from "./applications.$id"

// The application's Installed on tab (#436): an Add button records the
// application on a picked device or VM through the shared install dialog.

const { apiMock, saveMock, canDoMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  saveMock: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
  canDoMock: vi.fn<(model: string, action: string) => boolean>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: (await import("@/lib/test-page-size")).stripPageSize(apiMock),
}))
vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  useSaveObject: () => saveMock,
  usePlanTarget: () => null,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: canDoMock, humanIds: false }),
}))
vi.mock("@/components/device-picker", () => ({
  DevicePicker: ({ onChange }: { onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange("d1")}>
      Pick core-sw1
    </button>
  ),
}))

beforeEach(() => {
  apiMock.mockReset()
  saveMock.mockReset()
  canDoMock.mockReset()
  apiMock.mockResolvedValue({ count: 0, results: [] })
})
afterEach(cleanup)

function renderTab() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <InstalledOn applicationId="app-1" />
    </QueryClientProvider>
  )
}

describe("InstalledOn", () => {
  it("hides Add without the add permission", async () => {
    canDoMock.mockReturnValue(false)
    renderTab()
    await screen.findByText("Not installed anywhere yet.")
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull()
  })

  it("adds the application to a picked device", async () => {
    canDoMock.mockReturnValue(true)
    saveMock.mockResolvedValue({
      id: "sw-1",
      application: { id: "app-1", name: "PostgreSQL" },
    })
    renderTab()
    fireEvent.click(await screen.findByRole("button", { name: "Add" }))
    fireEvent.click(screen.getByRole("button", { name: "Pick core-sw1" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/services/?device=d1")
    )
    fireEvent.change(screen.getByPlaceholderText("16.4"), {
      target: { value: "16.4" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Add software" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    expect(saveMock.mock.calls[0][0].payload).toMatchObject({
      application_id: "app-1",
      device_id: "d1",
      version: "16.4",
    })
  })
})
