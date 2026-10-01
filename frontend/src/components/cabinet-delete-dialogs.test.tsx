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
import { ApiError } from "@/lib/api"
import type { CabinetRole, CabinetType } from "@/lib/api"
import { CabinetRoleDeleteDialog } from "./cabinet-role-delete-dialog"
import { CabinetTypeDeleteDialog } from "./cabinet-type-delete-dialog"

// A cabinet type or role in use can't be deleted: the server answers 409
// with how many cabinets use it. The dialogs say so before the click when the
// count shows it, and show the server's answer - and stay open - when cabinets
// took the type or role after the page loaded.

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))

const role = (cabinet_count: number): CabinetRole => ({
  id: "r1",
  numid: 1,
  name: "Distribution",
  slug: "distribution",
  color: "#2563eb",
  description: "",
  cabinet_count,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
})

const cabinetType = (cabinet_count: number): CabinetType => ({
  id: "t1",
  numid: 1,
  name: "AE 1060.500",
  manufacturer: null,
  inner_width_mm: 525,
  inner_height_mm: 650,
  outer_width_mm: 600,
  outer_height_mm: 700,
  outer_depth_mm: 210,
  rail_templates: [],
  description: "",
  cabinet_count,
  tags: [],
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
})

const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
const withClient = (children: React.ReactNode) => (
  <QueryClientProvider client={qc}>{children}</QueryClientProvider>
)
const wrap = (children: React.ReactNode) => render(withClient(children))

const deleteButton = () => screen.getByRole("button", { name: "Delete" })

beforeEach(() => {
  apiMock.mockReset()
  toastMock.mockReset()
})
afterEach(cleanup)

describe("CabinetRoleDeleteDialog", () => {
  it("deletes an unused role", async () => {
    apiMock.mockResolvedValue(undefined)
    const onOpenChange = vi.fn()
    const onDeleted = vi.fn()
    wrap(
      <CabinetRoleDeleteDialog
        role={role(0)}
        onOpenChange={onOpenChange}
        onDeleted={onDeleted}
      />
    )
    expect(screen.getByText("This action can't be undone.")).toBeTruthy()
    fireEvent.click(deleteButton())
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    expect(apiMock).toHaveBeenCalledWith("/api/cabinet-roles/r1/", {
      method: "DELETE",
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("says how many cabinets use it and won't send the delete", () => {
    wrap(<CabinetRoleDeleteDialog role={role(2)} onOpenChange={vi.fn()} />)
    expect(
      screen.getByText("2 cabinets use this role - unassign them first.")
    ).toBeTruthy()
    expect(deleteButton()).toHaveProperty("disabled", true)
    fireEvent.click(deleteButton())
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("shows the server's 409 in the dialog and stays open", async () => {
    apiMock.mockRejectedValue(
      new ApiError(409, { detail: "1 cabinet uses this role." })
    )
    const onOpenChange = vi.fn()
    wrap(<CabinetRoleDeleteDialog role={role(0)} onOpenChange={onOpenChange} />)
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(screen.getByText("1 cabinet uses this role.")).toBeTruthy()
    )
    expect(screen.queryByText("This action can't be undone.")).toBeNull()
    expect(deleteButton()).toHaveProperty("disabled", true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("toasts any other failure", async () => {
    const err = new ApiError(500, { detail: "boom" })
    apiMock.mockRejectedValue(err)
    wrap(<CabinetRoleDeleteDialog role={role(0)} onOpenChange={vi.fn()} />)
    fireEvent.click(deleteButton())
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(err))
    expect(screen.getByText("This action can't be undone.")).toBeTruthy()
  })
})

describe("CabinetTypeDeleteDialog", () => {
  it("says how many cabinets use it and won't send the delete", () => {
    wrap(
      <CabinetTypeDeleteDialog
        cabinetType={cabinetType(1)}
        onOpenChange={vi.fn()}
      />
    )
    expect(
      screen.getByText("1 cabinet uses this type - unassign them first.")
    ).toBeTruthy()
    expect(deleteButton()).toHaveProperty("disabled", true)
  })

  it("shows the server's 409 in the dialog and stays open", async () => {
    apiMock.mockRejectedValue(
      new ApiError(409, { detail: "3 cabinets use this type." })
    )
    const onOpenChange = vi.fn()
    wrap(
      <CabinetTypeDeleteDialog
        cabinetType={cabinetType(0)}
        onOpenChange={onOpenChange}
      />
    )
    fireEvent.click(deleteButton())
    await waitFor(() =>
      expect(screen.getByText("3 cabinets use this type.")).toBeTruthy()
    )
    expect(apiMock).toHaveBeenCalledWith("/api/cabinet-types/t1/", {
      method: "DELETE",
    })
    expect(deleteButton()).toHaveProperty("disabled", true)
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })

  it("forgets the refusal when opened on another type", async () => {
    apiMock.mockRejectedValue(
      new ApiError(409, { detail: "3 cabinets use this type." })
    )
    const view = wrap(
      <CabinetTypeDeleteDialog
        cabinetType={cabinetType(0)}
        onOpenChange={vi.fn()}
      />
    )
    fireEvent.click(deleteButton())
    await screen.findByText("3 cabinets use this type.")
    view.rerender(
      withClient(
        <CabinetTypeDeleteDialog
          cabinetType={{ ...cabinetType(0), id: "t2", name: "AE 1050.500" }}
          onOpenChange={vi.fn()}
        />
      )
    )
    expect(screen.getByText("This action can't be undone.")).toBeTruthy()
    expect(deleteButton()).toHaveProperty("disabled", false)
  })
})
