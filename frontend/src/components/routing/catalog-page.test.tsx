// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { RoutingDeleteDialog } from "./catalog-page"

// A routing object still in use is refused with a 409 whose detail says by
// what; the dialog shows that reason and stays open.

const { apiMock, toastError } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastError: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}))

afterEach(cleanup)

describe("RoutingDeleteDialog", () => {
  it("shows the server's in-use reason and stays open", async () => {
    const { ApiError } = await vi.importActual<typeof Api>("@/lib/api")
    apiMock.mockRejectedValue(
      new ApiError(409, { detail: "In use: 2 BGP sessions." })
    )
    const onOpenChange = vi.fn()
    const qc = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <RoutingDeleteDialog
          item={{ id: "pg1", name: "UPSTREAM" }}
          endpoint="/api/routing/bgp-peer-groups/"
          queryKey="bgp-peer-groups"
          label={(r) => r.name}
          onOpenChange={onOpenChange}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("In use: 2 BGP sessions.")
    )
    expect(apiMock).toHaveBeenCalledWith("/api/routing/bgp-peer-groups/pg1/", {
      method: "DELETE",
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
