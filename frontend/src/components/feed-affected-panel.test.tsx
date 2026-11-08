// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { AffectedPanel } from "./feed-affected-panel"

// A source's Affected tab (#434): its feeds, racks and devices, each rack and
// device with how hard the work hits it, and a way into planning it.

const { apiMock, navMock, canAdd } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  navMock: vi.fn(),
  canAdd: { current: true },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ canDo: () => canAdd.current }),
}))
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navMock,
  Link: ({
    children,
    to,
    params,
    className,
  }: {
    children: React.ReactNode
    to: string
    params: { id: string }
    className?: string
  }) => (
    <a className={className} href={to.replace("$id", params.id)}>
      {children}
    </a>
  ),
}))

const AFFECTED = {
  feeds: [
    {
      id: "f1",
      name: "CW-A",
      type: "primary",
      rack: { id: "r1", name: "A01" },
    },
  ],
  racks: [
    { id: "r1", name: "A01", level: "outage" },
    { id: "r2", name: "A02", level: "reduced_redundancy" },
  ],
  devices: [
    { id: "d1", name: "sw1", level: "outage", rack: { id: "r1", name: "A01" } },
  ],
  impacts: [],
}

beforeEach(() => {
  apiMock.mockReset()
  navMock.mockReset()
  canAdd.current = true
})
afterEach(cleanup)

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <AffectedPanel kind="coolingsource" id="cs1" name="CRAH-1" />
    </QueryClientProvider>
  )
}

describe("AffectedPanel", () => {
  it("lists feeds, racks and devices with their impact", async () => {
    apiMock.mockResolvedValue(AFFECTED)
    renderPanel()
    const rack = await screen.findByRole("link", { name: "A02" })
    expect(apiMock).toHaveBeenCalledWith("/api/cooling-sources/cs1/affected/")
    expect(rack.getAttribute("href")).toBe("/racks/r2")
    expect(
      screen.getByRole("link", { name: "CW-A" }).getAttribute("href")
    ).toBe("/cooling-feeds/f1")
    expect(screen.getByRole("link", { name: "sw1" }).getAttribute("href")).toBe(
      "/devices/d1"
    )
    expect(rack.closest("[data-row]")?.textContent).toContain(
      "Reduced redundancy"
    )
    expect(
      screen.getByRole("link", { name: "sw1" }).closest("[data-row]")
        ?.textContent
    ).toContain("Outage")
  })

  it("plans maintenance on the source", async () => {
    apiMock.mockResolvedValue(AFFECTED)
    renderPanel()
    fireEvent.click(
      await screen.findByRole("button", { name: /Plan maintenance/ })
    )
    expect(navMock).toHaveBeenCalledWith({
      to: "/maintenance/new",
      search: { affected_kind: "coolingsource", affected_id: "cs1" },
    })
  })

  it("hides planning without the permission, and says when nothing is downstream", async () => {
    canAdd.current = false
    apiMock.mockResolvedValue({
      feeds: [],
      racks: [],
      devices: [],
      impacts: [],
    })
    renderPanel()
    expect(await screen.findByText("Nothing downstream yet.")).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: /Plan maintenance/ })
    ).toBeNull()
  })
})
