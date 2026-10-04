// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BulkExport } from "./bulk-export"

// A bulk bar's Export POSTs the ids (#176): "Select all N" makes a selection
// of hundreds one click away, and that many UUIDs in a GET's query string
// pass the proxy's 8 KB request-line limit.

const { exportMock, downloadMock, toastMock } = vi.hoisted(() => ({
  exportMock:
    vi.fn<
      (
        slug: string,
        opts: { fmt: string; ids: string[] }
      ) => Promise<{ blob: Blob; filename: string }>
    >(),
  downloadMock: vi.fn(),
  toastMock: vi.fn(),
}))
vi.mock("@/lib/api", () => ({ ioExportFile: exportMock }))
vi.mock("@/lib/table-export", () => ({ downloadBlob: downloadMock }))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))

afterEach(cleanup)
beforeEach(() => {
  exportMock.mockReset()
  downloadMock.mockReset()
  toastMock.mockReset()
})

const ids = Array.from(
  { length: 300 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
)

function pick(label: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Export" }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
  fireEvent.click(screen.getByRole("menuitem", { name: label }))
}

describe("BulkExport", () => {
  it("posts every selected id and saves the file the server names", async () => {
    const blob = new Blob(["id\n"], { type: "text/csv" })
    exportMock.mockResolvedValue({ blob, filename: "vlan.csv" })
    render(<BulkExport ioType="vlan" ids={ids} />)
    expect(document.querySelector("a[href]")).toBeNull()

    pick("CSV (.csv)")

    await waitFor(() => expect(downloadMock).toHaveBeenCalled())
    expect(exportMock).toHaveBeenCalledWith("vlan", { fmt: "csv", ids })
    expect(downloadMock).toHaveBeenCalledWith("vlan.csv", "text/csv", blob)
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("shows a refusal as a toast instead of saving it as the file", async () => {
    const err = new Error("You can't view vlan.")
    exportMock.mockRejectedValue(err)
    render(<BulkExport ioType="vlan" ids={ids.slice(0, 2)} />)

    pick("JSON (.json)")

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(err))
    expect(downloadMock).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Export" }).hasAttribute("disabled")
      ).toBe(false)
    )
  })

  it("renders nothing without a selection", () => {
    const { container } = render(<BulkExport ioType="vlan" ids={[]} />)
    expect(container.innerHTML).toBe("")
  })
})
