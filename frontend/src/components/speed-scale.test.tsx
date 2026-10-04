// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"

import { SPEED_TIERS } from "@/lib/speed"
import { HardwareStatusKey, SpeedScale } from "./speed-scale"

afterEach(cleanup)

const STATUSES = [
  { id: "s-active", name: "Active", color: "#10b981", text_color: "" },
  { id: "s-failed", name: "Failed", color: "#ef4444", text_color: "" },
  { id: "s-spare", name: "Spare", color: "", text_color: "" },
]

function withStatuses(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(["statuses", "inventoryitem"], {
    count: STATUSES.length,
    next: null,
    previous: null,
    results: STATUSES,
  })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe("SpeedScale", () => {
  it("draws the whole shared ramp, each segment named by its label", () => {
    const { container } = render(<SpeedScale />)
    for (const t of SPEED_TIERS) expect(screen.getByText(t.label)).toBeTruthy()
    expect(screen.getByText("<100M")).toBeTruthy()
    // Named by the label under it - no browser tooltip.
    expect(container.querySelector("[title]")).toBeNull()
  })
})

describe("HardwareStatusKey", () => {
  it("shows the drawn parts' statuses as their pills, never a swatch and a name", () => {
    const { container } = withStatuses(
      <HardwareStatusKey statusIds={new Set(["s-active", "s-spare"])} />
    )
    const pills = [...container.querySelectorAll("[data-slot=badge]")]
    expect(pills.map((p) => p.textContent)).toEqual(["Active", "Spare"])
    expect((pills[0] as HTMLElement).style.backgroundColor).toBe(
      "rgb(16, 185, 129)"
    )
    // No status the panel didn't draw, and no colour square beside a name.
    expect(screen.queryByText("Failed")).toBeNull()
    expect(container.querySelector(".rounded-\\[3px\\]")).toBeNull()
  })

  it("renders nothing for a panel without parts", () => {
    const { container } = withStatuses(
      <HardwareStatusKey statusIds={new Set()} />
    )
    expect(container.innerHTML).toBe("")
  })
})
