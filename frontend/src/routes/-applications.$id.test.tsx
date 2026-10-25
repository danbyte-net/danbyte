// @vitest-environment jsdom
import type { ReactNode } from "react"
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
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}))

beforeEach(() => {
  apiMock.mockReset()
  saveMock.mockReset()
  canDoMock.mockReset()
  apiMock.mockResolvedValue({ count: 0, results: [] })
})
afterEach(cleanup)

function renderTab(props: { cycle?: string; onClearCycle?: () => void } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <InstalledOn applicationId="app-1" {...props} />
    </QueryClientProvider>
  )
}

describe("InstalledOn filtered to a cycle", () => {
  it("asks for the cycle, marks a cycle set by hand and clears", async () => {
    canDoMock.mockReturnValue(false)
    apiMock.mockImplementation(async (path: string) =>
      path.startsWith("/api/installed-software/")
        ? {
            count: 1,
            results: [
              {
                id: "sw-1",
                application: {
                  id: "app-1",
                  name: "Java",
                  slug: "java",
                  path: "Java",
                },
                device: { id: "d1", name: "app01" },
                virtual_machine: null,
                version: "8u402",
                cycle: "8",
                cycle_manual: true,
                service: null,
                eol: null,
                source: "manual",
                tags: [],
                custom_fields: {},
              },
            ],
          }
        : { count: 0, results: [] }
    )
    const clear = vi.fn()
    renderTab({ cycle: "8", onClearCycle: clear })
    expect(await screen.findByText("manual")).toBeTruthy()
    expect(apiMock).toHaveBeenCalledWith(
      "/api/installed-software/?application=app-1&cycle=8"
    )
    expect(screen.getByText("Cycle 8")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Clear cycle" }))
    expect(clear).toHaveBeenCalled()
  })
})

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
