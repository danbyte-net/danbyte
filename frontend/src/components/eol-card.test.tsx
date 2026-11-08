// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { Application, ApplicationEolDetail } from "@/lib/api"
import { ApplicationEolCard } from "./eol-card"

// The application's End of life card (#436): the product linked to the
// source's page, every cycle with the installs on it linked to the Installed
// on tab, the unmapped installs, the idle cycles behind a toggle, and a plain
// line when the product does not fit.

const { apiMock, meMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  meMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: meMock }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    children,
    search,
    hash,
    to,
  }: {
    children?: ReactNode
    search?: Record<string, string>
    hash?: string
    to?: string
  }) => (
    <a
      data-to={to}
      data-search={search ? JSON.stringify(search) : undefined}
      data-hash={hash}
    >
      {children}
    </a>
  ),
  useNavigate: () => () => {},
}))

const APP = {
  id: "app-1",
  name: "Java",
  eol: { source: "endoflife_date", product: "java", cycles: [] },
} as unknown as Application

function detail(
  patch: Partial<ApplicationEolDetail> = {}
): ApplicationEolDetail {
  return {
    source: "endoflife_date",
    product: "java",
    cycles: [
      {
        cycle: "8",
        status: "ending",
        release_date: "2014-03-18",
        eol_date: "2030-12-31",
        lts: true,
        latest_version: "8u412",
        install_count: 3,
      },
    ],
    other_cycles: [
      { cycle: "21", status: "supported", lts: true, install_count: 0 },
    ],
    unmapped_installs: 2,
    in_catalog: true,
    source_label: "endoflife.date",
    product_label: "Java",
    product_url: "https://endoflife.date/java",
    ...patch,
  }
}

function renderCard(d: ApplicationEolDetail, manage = false) {
  meMock.mockReturnValue({
    me: {},
    canDo: () => true,
    canManageDeployment: manage,
  })
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/eol/settings/")
      return { enabled: true, warning_days: 180 }
    if (path === "/api/applications/app-1/eol/") return d
    throw new Error(path)
  })
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <ApplicationEolCard application={APP} canEdit />
    </QueryClientProvider>
  )
}

beforeEach(() => {
  apiMock.mockReset()
  meMock.mockReset()
})
afterEach(cleanup)

describe("ApplicationEolCard", () => {
  it("links the product and the installs on each cycle", async () => {
    renderCard(detail(), true)
    const product = await screen.findByRole("link", { name: /Java/ })
    expect(product.getAttribute("href")).toBe("https://endoflife.date/java")
    expect(product.getAttribute("target")).toBe("_blank")
    expect(screen.getByText("endoflife.date").getAttribute("data-hash")).toBe(
      "end-of-life-data"
    )
    const three = screen.getByText("3")
    expect(JSON.parse(three.getAttribute("data-search")!)).toEqual({
      tab: "installs",
      cycle: "8",
    })
    expect(screen.getByText("Unmapped")).toBeTruthy()
    expect(
      JSON.parse(screen.getByText("2").getAttribute("data-search")!)
    ).toEqual({ tab: "installs", cycle: "none" })
    expect(screen.getByText("8u412")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Change product/ })).toBeTruthy()
    expect(screen.getByRole("button", { name: /Refresh now/ })).toBeTruthy()
  })

  it("keeps the idle cycles behind a toggle", async () => {
    renderCard(detail())
    await screen.findByText("8u412")
    expect(screen.queryByText("21")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: /All cycles/ }))
    expect(screen.getByText("21")).toBeTruthy()
    // Only a deployment manager refreshes the catalog.
    expect(screen.queryByRole("button", { name: /Refresh now/ })).toBeNull()
  })

  it("says plainly when the product does not fit", async () => {
    renderCard(
      detail({
        product: "php",
        product_label: "PHP",
        cycles: [],
        other_cycles: [],
        unmapped_installs: 4,
      })
    )
    expect(
      await screen.findByText(
        "No install's version matches a cycle of this product."
      )
    ).toBeTruthy()
    cleanup()
    renderCard(
      detail({
        product: "php",
        in_catalog: false,
        product_label: null,
        cycles: [],
        other_cycles: [],
      })
    )
    expect(await screen.findByText("Not in the cached catalog.")).toBeTruthy()
  })
})
