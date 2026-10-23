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
import type { InstalledSoftware } from "@/lib/api"
import { InstalledSoftwareDialog } from "./installed-software-pane"

// The Software tab's dialog (#436): the install lands on the tab's device or
// VM, the service list is that parent's own, and a cycle left blank is
// derived from the version on the server.

const { apiMock, saveMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  saveMock: vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/save-object", async (orig) => ({
  ...(await orig<object>()),
  useSaveObject: () => saveMock,
  usePlanTarget: () => null,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@/components/application-picker", () => ({
  ApplicationPicker: ({ onChange }: { onChange: (v: string) => void }) => (
    <button type="button" onClick={() => onChange("app-1")}>
      Pick PostgreSQL
    </button>
  ),
}))

beforeEach(() => {
  apiMock.mockReset()
  saveMock.mockReset()
  apiMock.mockResolvedValue({ count: 0, results: [] })
})
afterEach(cleanup)

const saved = {
  id: "sw-1",
  application: {
    id: "app-1",
    name: "PostgreSQL",
    slug: "postgresql",
    path: "PostgreSQL",
  },
} as InstalledSoftware

function renderDialog(
  parent: { kind: "device" | "vm"; id: string },
  install: InstalledSoftware | null = null
) {
  const onSaved = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <InstalledSoftwareDialog
        parent={parent}
        install={install}
        open
        onOpenChange={() => {}}
        onSaved={onSaved}
      />
    </QueryClientProvider>
  )
  return { onSaved }
}

describe("InstalledSoftwareDialog", () => {
  it("adds software to the tab's device with the parent's services", async () => {
    saveMock.mockResolvedValue(saved)
    const { onSaved } = renderDialog({ kind: "device", id: "d1" })
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/services/?device=d1")
    )
    fireEvent.click(screen.getByRole("button", { name: "Pick PostgreSQL" }))
    fireEvent.change(screen.getByPlaceholderText("16.4"), {
      target: { value: " 16.4 " },
    })
    fireEvent.click(
      screen.getAllByRole("button", { name: "Add software" }).at(-1)!
    )
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(saved))
    const args = saveMock.mock.calls[0][0]
    expect(args.endpoint).toBe("/api/installed-software/")
    expect(args.id).toBeUndefined()
    expect(args.payload).toMatchObject({
      application_id: "app-1",
      device_id: "d1",
      version: "16.4",
      cycle: "",
      service_id: null,
    })
  })

  it("edits on a VM and keeps a derived cycle derived", async () => {
    saveMock.mockResolvedValue(saved)
    const install = {
      ...saved,
      version: "15",
      cycle: "15",
      cycle_manual: false,
      service: null,
      release_date: null,
      end_of_support: null,
      description: "",
    } as InstalledSoftware
    renderDialog({ kind: "vm", id: "v1" }, install)
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/services/?vm=v1")
    )
    expect(screen.getByPlaceholderText("15")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(saveMock).toHaveBeenCalled())
    const args = saveMock.mock.calls[0][0]
    expect(args.id).toBe("sw-1")
    expect(args.payload).toMatchObject({ virtual_machine_id: "v1", cycle: "" })
  })
})
