// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import { PortUtilizationCard } from "./port-utilization-card"

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

afterEach(cleanup)

const row = (total: number, connected = 0, reserved = 0) => ({
  total,
  connected,
  reserved,
  free: total - connected - reserved,
  marked: 0,
})

// A switch: 4 physical ports (one cabled, one planned), 3 virtual ones (one
// cabled), and a rear port the total never includes.
const payload = (countVirtual: boolean) => ({
  interfaces: row(4, 1, 1),
  virtual: row(3, 1),
  front_ports: row(0),
  rear_ports: row(1),
  combined: countVirtual ? row(7, 2, 1) : row(4, 1, 1),
  count_virtual: countVirtual,
})

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <PortUtilizationCard deviceId="d1" />
    </QueryClientProvider>
  )
}

describe("PortUtilizationCard", () => {
  beforeEach(() => apiMock.mockReset())

  it("names the virtual interfaces it left out", async () => {
    apiMock.mockResolvedValue(payload(false))
    renderCard()
    expect(await screen.findByText(/virtual · not counted/)).toBeTruthy()
    expect(screen.getByText("ports used").parentElement!.textContent).toBe(
      "2 of 4 ports used"
    )
    // One counted kind, so no per-kind breakdown - and never rear ports.
    expect(screen.queryByText("Virtual interfaces")).toBeNull()
    expect(screen.queryByText("Rear ports")).toBeNull()
  })

  it("breaks the counted virtual interfaces out when they count", async () => {
    apiMock.mockResolvedValue(payload(true))
    renderCard()
    expect(await screen.findByText("Virtual interfaces")).toBeTruthy()
    expect(screen.getByText("Interfaces")).toBeTruthy()
    expect(screen.getByText("ports used").parentElement!.textContent).toBe(
      "3 of 7 ports used"
    )
    expect(screen.queryByText(/not counted/)).toBeNull()
  })
})
