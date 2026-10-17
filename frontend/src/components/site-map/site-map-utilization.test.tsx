// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { UTIL_BANDS, UTIL_NO_DATA } from "./line-utilization"
import type { LineUtil } from "./line-utilization"
import { SiteMapLegend } from "./site-map-legend"
import { utilLabelLines } from "./speed-labels"
import type { DrawnCable } from "./cable-geo-route"

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: vi.fn(() => Promise.reject(new Error("offline"))),
}))

afterEach(cleanup)
beforeEach(() => localStorage.setItem("site-map:legend", "open"))

describe("SiteMapLegend - Utilization", () => {
  it("keys every band, No data and the time of the newest sample", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <SiteMapLegend colorBy="utilization" asOf="2026-10-10T10:00:00Z" />
        </TooltipProvider>
      </QueryClientProvider>
    )
    expect(screen.getByText("Color by utilization")).toBeTruthy()
    for (const b of [...UTIL_BANDS, UTIL_NO_DATA]) {
      const line = screen
        .getByText(b.label)
        .previousElementSibling!.querySelector("line")!
      expect(line.getAttribute("stroke")).toBe(b.hex)
    }
    expect(screen.getByText(/As of/).closest("[data-slot=as-of]")).toBeTruthy()
  })
})

describe("utilLabelLines", () => {
  const cable = (id: string, path: [number, number][]): DrawnCable => ({
    id,
    label: id,
    color: "",
    path,
    routed: false,
  })

  it("puts one chip on each half, pointing at the middle", () => {
    const util = new Map<string, LineUtil>([
      ["c1", { az: { bps: 1, pct: 42 }, za: null, at: null }],
    ])
    const lines = utilLabelLines({
      connections: [],
      cables: [
        cable("c1", [
          [0, 0],
          [0, 4],
        ]),
      ],
      util,
    })
    expect(lines.map((l) => [l.id, l.label])).toEqual([
      ["c1:az", "42%"],
      ["c1:za", "No data"],
    ])
    const [az, za] = lines
    expect(az.at[1]).toBeCloseTo(1)
    expect(za.at[1]).toBeCloseTo(3)
    expect(az.toward).toEqual([0, 2])
    expect(za.toward).toEqual([0, 2])
  })

  it("gives cables drawn on one line one pair of chips", () => {
    const path: [number, number][] = [
      [0, 0],
      [0, 4],
    ]
    const lines = utilLabelLines({
      connections: [],
      cables: [cable("c1", path), cable("c2", path)],
      util: new Map(),
    })
    expect(lines).toHaveLength(2)
  })
})
