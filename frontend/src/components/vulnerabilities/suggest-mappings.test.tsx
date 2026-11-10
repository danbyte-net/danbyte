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
import type { SuggestionsPage } from "@/lib/vuln-suggestions"
import { SuggestMappingsDialog } from "./suggest-mappings"

// Suggest mappings (#451): the dialog ticks only high-confidence rows, lists
// a row without a candidate with Pick…, and sends the ticked rows to
// bulk-create in one request.

const { apiMock, toastSuccess } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastSuccess: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, can: () => true }),
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: vi.fn() },
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const cpe = (id: string, confidence: "high" | "medium" | "low") => {
  const [, , part, vendor, product] = id.split(":")
  return {
    kind: "cpe" as const,
    part: part as "o",
    vendor,
    product,
    identifier: id,
    source: "known" as const,
    confidence,
    title: "",
    version_scheme: "auto" as const,
    scheme: "generic" as const,
  }
}

const PAGE: SuggestionsPage = {
  count: 3,
  results: [
    {
      subject_type: "platform",
      id: "p-xe",
      name: "IOS-XE",
      manufacturer: "Cisco",
      purl_template: "",
      cpe_template: "",
      in_use: 12,
      without_version: 2,
      candidates: [cpe("cpe:2.3:o:cisco:ios_xe", "high")],
    },
    {
      subject_type: "platform",
      id: "p-ios",
      name: "IOS",
      manufacturer: "",
      purl_template: "",
      cpe_template: "",
      in_use: 3,
      without_version: 0,
      candidates: [cpe("cpe:2.3:o:cisco:ios", "medium")],
    },
    {
      subject_type: "application",
      id: "a-odd",
      name: "In-house tool",
      manufacturer: "",
      purl_template: "",
      cpe_template: "",
      in_use: 1,
      without_version: 0,
      candidates: [],
    },
  ],
  totals: { subjects: 3, in_use: 16, without_version: 2, with_candidate: 2 },
  update_source: "server",
  nvd_status: "not_asked",
  nvd_pending: 1,
}

function mount() {
  const onOpenChange = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SuggestMappingsDialog onOpenChange={onOpenChange} />
    </QueryClientProvider>
  )
  return onOpenChange
}

afterEach(cleanup)

describe("SuggestMappingsDialog", () => {
  beforeEach(() => {
    apiMock.mockReset()
    toastSuccess.mockReset()
    apiMock.mockImplementation(async (path) => {
      if (path.includes("bulk-create"))
        return {
          created: [{ id: "m1", identifier: "cpe:2.3:o:cisco:ios_xe" }],
          update_source: "server",
        }
      return PAGE
    })
  })

  it("ticks high confidence only and offers Pick… without a candidate", async () => {
    mount()
    const xe = await screen.findByLabelText<HTMLButtonElement>("Map IOS-XE")
    expect(xe.getAttribute("data-state")).toBe("checked")
    expect(screen.getByLabelText("Map IOS").getAttribute("data-state")).toBe(
      "unchecked"
    )
    expect(screen.getByText("Pick…")).toBeTruthy()
    expect(screen.getByText("2 without a version")).toBeTruthy()
    expect(screen.getByText("Create 1 mapping")).toBeTruthy()
    expect(screen.getByText("Search NVD for 1")).toBeTruthy()
  })

  it("creates the ticked rows in one request", async () => {
    const onOpenChange = mount()
    fireEvent.click(await screen.findByLabelText("Map IOS"))
    fireEvent.click(screen.getByText("Create 2 mappings"))
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    const posts = apiMock.mock.calls.filter(([p]) => p.includes("bulk-create"))
    expect(posts).toHaveLength(1)
    expect(JSON.parse(String(posts[0][1]?.body))).toEqual([
      { platform: "p-xe", identifier: "cpe:2.3:o:cisco:ios_xe" },
      { platform: "p-ios", identifier: "cpe:2.3:o:cisco:ios" },
    ])
    expect(toastSuccess).toHaveBeenCalledWith(
      "Created 1 mapping",
      expect.objectContaining({ description: "Fetching their records now." })
    )
  })
})
