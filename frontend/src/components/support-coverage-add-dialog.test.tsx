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
import {
  SupportCoverageAddDialog,
  countSerials,
} from "./support-coverage-add-dialog"

// Pasting serial numbers (#421) posts them as given; the server matches them
// within the tenant. What it could not match - not found, or on several
// devices - stays on screen so the operator can fix the list.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/components/device-picker", () => ({
  DevicePicker: () => null,
}))

beforeEach(() => apiMock.mockReset())
afterEach(cleanup)

function renderDialog() {
  const onOpenChange = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <SupportCoverageAddDialog
        contractId="k1"
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

describe("countSerials", () => {
  it("splits like the server and ignores case duplicates", () => {
    expect(countSerials("a1\nB2, b2; c3  d4\n\n")).toBe(4)
    expect(countSerials("   ")).toBe(0)
  })
})

describe("SupportCoverageAddDialog", () => {
  it("posts pasted serials and keeps the unmatched ones on screen", async () => {
    apiMock.mockResolvedValue({
      created: 2,
      existing: 1,
      matched: 3,
      unmatched: ["ZZZ"],
      ambiguous: ["DUP"],
    })
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Serial numbers" }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A1\nA2\nA3\nZZZ\nDUP" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Match 5" }))
    await screen.findByTestId("coverage-result")
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/support-coverage/bulk-add/")
    expect(JSON.parse(String(init?.body))).toEqual({
      contract_id: "k1",
      serials: "A1\nA2\nA3\nZZZ\nDUP",
    })
    expect(screen.getByText("2 added")).toBeTruthy()
    expect(screen.getByText("1 already covered")).toBeTruthy()
    expect(screen.getByText("1 not found")).toBeTruthy()
    expect(screen.getByText("1 on several devices")).toBeTruthy()
    expect(screen.getByRole<HTMLTextAreaElement>("textbox").value).toBe(
      "ZZZ\nDUP"
    )
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("closes when every serial matched", async () => {
    apiMock.mockResolvedValue({
      created: 1,
      existing: 0,
      matched: 1,
      unmatched: [],
      ambiguous: [],
    })
    const { onOpenChange } = renderDialog()
    fireEvent.click(screen.getByRole("button", { name: "Serial numbers" }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "A1" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Match 1" }))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })
})
