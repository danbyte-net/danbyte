// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { flexRender } from "@tanstack/react-table"

import type { Device, LifecycleNext, VirtualMachine } from "@/lib/api"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import {
  LifecycleBar,
  LifetimeBar,
  countdownText,
  hasLifetime,
  lifecycleNextColumn,
  lifetimeFacts,
} from "./lifecycle-cell"

// The one time bar (#436): its share, its colour by time left against the
// source's warning window, its countdown and what it draws when dates are
// missing - never an empty track.

vi.mock("@/lib/use-me", () => ({ useMe: () => ({ me: {} }) }))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: () => Promise.resolve({ enabled: true, warning_days: 180 }),
}))

const TODAY = "2026-06-15"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

const track = (c: HTMLElement) => c.querySelector("[aria-hidden] > span")

describe("lifetimeFacts", () => {
  it("fills the elapsed share of start to end, clamped", () => {
    const at = (start: string, end: string) =>
      lifetimeFacts({ start, end, today: TODAY }).pct
    expect(at("2026-06-05", "2026-06-25")).toBe(50)
    expect(at("2026-07-01", "2027-07-01")).toBe(0)
    expect(at("2020-01-01", "2026-01-01")).toBe(100)
    // No start, or a start that is not before the end: no share.
    expect(lifetimeFacts({ end: "2027-01-01", today: TODAY }).pct).toBeNull()
    expect(at("2027-01-01", "2026-12-01")).toBeNull()
  })

  it("colours by time left against the window, not by the share", () => {
    const tone = (end: string, label?: "eol" | "coverage") =>
      lifetimeFacts({ end, warningDays: 90, today: TODAY, label }).tone
    // A ten-year window 95 % used but a year from its end stays primary.
    expect(
      lifetimeFacts({
        start: "2017-06-15",
        end: "2027-06-15",
        warningDays: 90,
        today: TODAY,
      }).tone
    ).toBe("primary")
    expect(tone("2026-09-13")).toBe("warning") // 90 d: the window's edge
    expect(tone("2026-09-14")).toBe("primary") // 91 d
    expect(tone("2026-06-16")).toBe("warning")
    // An end of life is reached on its day; coverage covers its last day.
    expect(tone(TODAY)).toBe("destructive")
    expect(tone(TODAY, "coverage")).toBe("warning")
    expect(tone("2026-06-14", "coverage")).toBe("destructive")
    // No window yet (settings loading): only a passed end is coloured.
    expect(lifetimeFacts({ end: "2026-06-20", today: TODAY }).tone).toBe(
      "primary"
    )
  })

  it("counts down tersely", () => {
    expect(countdownText(800)).toBe("EoL in 2 y")
    expect(countdownText(90)).toBe("EoL in 3 mo")
    expect(countdownText(40)).toBe("EoL in 40 d")
    expect(countdownText(0)).toBe("EoL today")
    expect(countdownText(-95)).toBe("EoL 3 mo ago")
    expect(countdownText(40, "coverage")).toBe("Ends in 40 d")
    expect(countdownText(0, "coverage")).toBe("Ends today")
    expect(countdownText(-61, "coverage")).toBe("Ended 2 mo ago")
    expect(lifetimeFacts({ end: "2026-07-25", today: TODAY }).daysLeft).toBe(40)
  })
})

describe("LifetimeBar", () => {
  it("draws the track with the share and the countdown", () => {
    const { container } = wrap(
      <LifetimeBar start="2026-06-05" end="2026-06-25" warningDays={30} />
    )
    expect(screen.getByText("EoL in 10 d")).toBeTruthy()
    const fill = track(container) as HTMLElement
    expect(fill.style.width).toBe("50%")
    expect(fill.className).toContain("bg-amber-500")
    expect(
      container
        .querySelector("[data-slot=lifetime-bar]")
        ?.getAttribute("data-tone")
    ).toBe("warning")
  })

  it("shows the countdown alone with an end and no start", () => {
    const { container } = wrap(
      <LifetimeBar end="2026-07-25" warningDays={90} label="coverage" />
    )
    expect(screen.getByText("Ends in 40 d")).toBeTruthy()
    expect(track(container)).toBeNull()
  })

  it("shows the source's pill alone with no end, else a muted placeholder", () => {
    wrap(<LifetimeBar start="2020-01-01" fallback={<span>Open-ended</span>} />)
    expect(screen.getByText("Open-ended")).toBeTruthy()
    cleanup()
    const { container } = wrap(<LifetimeBar start="2020-01-01" />)
    expect(container.textContent).toBe("-")
    expect(track(container)).toBeNull()
    cleanup()
    wrap(<LifetimeBar empty="No dates" />)
    expect(screen.getByText("No dates")).toBeTruthy()
  })
})

describe("LifecycleBar", () => {
  it("reads a platform's effective dates, entered or mapped", async () => {
    const { container } = wrap(
      <LifecycleBar
        item={{
          release_date: null,
          end_of_support: null,
          effective_release: "2022-04-21",
          effective_end: "2026-08-14",
          effective_source: "endoflife_date",
        }}
      />
    )
    expect(screen.getByText("EoL in 2 mo")).toBeTruthy()
    expect(track(container)).not.toBeNull()
  })

  it("falls back to the state when there is no end", () => {
    const mapped = {
      effective_end: null,
      effective_source: "endoflife_date",
      eol: { status: "eol" as const },
    }
    wrap(<LifecycleBar item={mapped} />)
    expect(screen.getByText("End of life")).toBeTruthy()
    cleanup()
    wrap(<LifecycleBar item={{ lifecycle_state: "eos" }} />)
    expect(screen.getByText("End of sale")).toBeTruthy()
    expect(hasLifetime({ lifecycle_state: "" })).toBe(false)
    expect(hasLifetime(mapped)).toBe(true)
    expect(hasLifetime({ end_of_support: "2030-01-01" })).toBe(true)
  })
})

describe("Next end of life column", () => {
  type Row = { lifecycle_next: LifecycleNext | null }
  const col = lifecycleNextColumn<Row>({ get: (r) => r.lifecycle_next })
  const os: Row = {
    lifecycle_next: { source: "os", end: "2026-08-14", start: "2022-04-21" },
  }
  const coverage: Row = {
    lifecycle_next: { source: "coverage", end: "2026-07-25", start: null },
  }
  const none: Row = { lifecycle_next: null }
  const sortValue = (r: Row) =>
    (col as { accessorFn: (r: Row, i: number) => number }).accessorFn(r, 0)

  it("is hidden until ticked, on the device and VM lists alike", () => {
    expect(col.meta?.defaultHidden).toBe(true)
    for (const cols of [
      buildDeviceColumns<Device>(),
      buildVmColumns<VirtualMachine>(),
    ]) {
      const next = cols.find((c) => c.id === "lifecycle_next")
      expect(next?.meta?.defaultHidden).toBe(true)
    }
  })

  it("sorts by days left, the undated last, and exports the date", () => {
    expect(sortValue(coverage)).toBe(40)
    expect(sortValue(os)).toBe(60)
    expect(sortValue(none)).toBe(Infinity)
    expect(col.meta?.export?.value(os)).toBe("2026-08-14 (OS)")
    expect(col.meta?.export?.value(none)).toBe("")
  })

  it("draws the bar and names the source", () => {
    const { container } = wrap(
      flexRender(col.cell, { row: { original: os } } as never)
    )
    expect(screen.getByText("EoL in 2 mo")).toBeTruthy()
    expect(screen.getByText("· OS")).toBeTruthy()
    expect(track(container)).not.toBeNull()
    cleanup()
    wrap(flexRender(col.cell, { row: { original: coverage } } as never))
    expect(screen.getByText("Ends in 40 d")).toBeTruthy()
    expect(screen.getByText("· Coverage")).toBeTruthy()
  })
})
