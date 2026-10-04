// @vitest-environment jsdom
import { useState } from "react"
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SiteCapacity, SiteCapacityRack } from "@/lib/api"

import { SiteCapacityTab, showCapacityTab } from "./site-capacity"

// A site's Capacity tab (#247): one card per floor plan - its rack tiles in
// small, coloured by the picked measure, and its racks added up - and one
// for the racks on no floor plan. It shows only where there are racks to
// read, for people who may see racks.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
    search,
    className,
  }: {
    children: ReactNode
    to: string
    params?: { id: string }
    search?: Record<string, string>
    className?: string
  }) => (
    <a
      className={className}
      href={`${to.replace("$id", params?.id ?? "")}${
        search ? `?${new URLSearchParams(search).toString()}` : ""
      }`}
    >
      {children}
    </a>
  ),
}))
// The measure lives in the URL on the page; here, in state.
vi.mock("@/lib/use-url-tab", () => ({
  useUrlTab: <T extends string>(initial: T) => useState<T>(initial),
}))

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(cleanup)

const ports = (connected: number, total: number) => ({
  total,
  connected,
  reserved: 0,
  free: total - connected,
  marked: 0,
})
const NONE = ports(0, 0)

const rack = (
  id: string,
  u_used: number,
  power: SiteCapacityRack["power"],
  patch: Partial<SiteCapacityRack> = {}
): SiteCapacityRack => ({
  id,
  name: id.toUpperCase(),
  role: null,
  status: null,
  u_height: 10,
  u_used,
  u_pct: u_used * 10,
  power,
  ports: ports(2, 10),
  panel_ports: NONE,
  device_count: 2,
  ...patch,
})
const feed = (available_w: number, allocated_w: number) => ({
  available_w,
  allocated_w,
  maximum_w: allocated_w,
  supply: "feed" as const,
})

const TOTALS = {
  racks: 3,
  devices: 6,
  u_height: 30,
  u_used: 18,
  u_pct: 60,
  power: {
    available_w: 8_000,
    allocated_w: 6_100,
    maximum_w: 6_100,
    pdu_rating: 1,
    no_supply: 1,
  },
  ports: ports(6, 30),
  panel_ports: ports(20, 24),
}

const CAPACITY: SiteCapacity = {
  site: { id: "s1", name: "Lab" },
  count_virtual: false,
  totals: TOTALS,
  floor_plans: [
    {
      id: "p1",
      name: "Hall C",
      location: { id: "l1", name: "Building 2" },
      grid_width: 9,
      grid_height: 8,
      totals: TOTALS,
      racks: [
        // Space 2/10 good, power 30 % good.
        rack("r1", 2, feed(4_000, 1_200)),
        // Space 9/10 warn, power over its feed.
        rack("r2", 9, feed(2_000, 4_900)),
        // Space 7/10 good, no supply: no data on power.
        rack("r3", 7, {
          available_w: 0,
          allocated_w: 0,
          maximum_w: 0,
          supply: null,
        }),
      ],
      tiles: [
        { rack_id: "r1", x: 1, y: 1, w: 1, h: 1, orientation: 0 },
        { rack_id: "r2", x: 2, y: 1, w: 1, h: 1, orientation: 0 },
        { rack_id: "r3", x: 3, y: 1, w: 1, h: 1, orientation: 180 },
      ],
    },
    {
      id: "p2",
      name: "Office",
      location: { id: "l2", name: "Building 1" },
      grid_width: 6,
      grid_height: 4,
      totals: { ...TOTALS, racks: 0 },
      racks: [],
      tiles: [],
    },
  ],
  unplaced: {
    totals: { ...TOTALS, racks: 1, devices: 2 },
    racks: [rack("r9", 4, feed(1_000, 500))],
  },
}

function mount() {
  apiMock.mockImplementation((path: string) =>
    path === "/api/sites/s1/capacity/"
      ? Promise.resolve(CAPACITY)
      : new Promise(() => undefined)
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <SiteCapacityTab siteId="s1" />
    </QueryClientProvider>
  )
}

const levels = (container: HTMLElement) =>
  [...container.querySelectorAll("svg [data-rack]")].map((g) => [
    g.getAttribute("data-rack"),
    g.getAttribute("data-level"),
  ])

describe("showCapacityTab", () => {
  it("shows only for a site with racks, to people who may view racks", () => {
    expect(showCapacityTab({ rack_count: 3 }, true)).toBe(true)
    expect(showCapacityTab({ rack_count: 0 }, true)).toBe(false)
    expect(showCapacityTab({ rack_count: 3 }, false)).toBe(false)
  })
})

describe("SiteCapacityTab", () => {
  it("draws a card per floor plan and one for racks on none", async () => {
    const { container } = mount()
    expect(await screen.findByText("Hall C")).toBeTruthy()
    expect(screen.getByText("Building 2")).toBeTruthy()
    expect(screen.getByText("Not on a floor plan")).toBeTruthy()
    expect(screen.getByText("R9").getAttribute("href")).toBe("/racks/r9")
    // A plan without racks says so rather than drawing empty figures.
    expect(screen.getByText("No racks on this plan.")).toBeTruthy()
    // Plans with racks first.
    const titles = [
      ...container.querySelectorAll("[data-slot=card-title]"),
    ].map((t) => t.textContent)
    expect(titles).toEqual(["Hall C", "Office", "Not on a floor plan"])
    // The plan opens from its name; the ports open the site's breakdown.
    expect(screen.getByText("Hall C").getAttribute("href")).toBe(
      "/floorplans/p1"
    )
    const portLinks = [...container.querySelectorAll("a")].filter((a) =>
      a.getAttribute("href")?.startsWith("/port-utilization")
    )
    expect(portLinks.length).toBeGreaterThan(0)
    for (const a of portLinks)
      expect(a.getAttribute("href")).toBe("/port-utilization?site=s1")
  })

  it("adds the racks up as the rack page reads one", async () => {
    mount()
    await screen.findByText("Hall C")
    expect(screen.getAllByText("18/30U · 60%").length).toBeGreaterThan(0)
    expect(screen.getAllByText("6.1 kW / 8 kW").length).toBeGreaterThan(0)
    expect(screen.getAllByText("PDU rating: 1 · No supply: 1").length).toBe(2)
    expect(screen.getAllByText("20 / 24").length).toBeGreaterThan(0)
  })

  it("colours the thumbnail's racks by the picked measure", async () => {
    const { container } = mount()
    await screen.findByText("Hall C")
    expect(levels(container)).toEqual([
      ["r1", "good"],
      ["r2", "warn"],
      ["r3", "good"],
    ])
    fireEvent.click(screen.getByRole("button", { name: "Power" }))
    expect(levels(container)).toEqual([
      ["r1", "good"],
      ["r2", "critical"],
      ["r3", "none"],
    ])
  })
})
