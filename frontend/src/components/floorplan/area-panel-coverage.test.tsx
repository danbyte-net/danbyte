// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"

import { AreaPanel } from "./area-panel"
import type { AreaShape } from "./shapes"

// An area's panel writes how much of it the cameras see beside its label,
// and leaves the row out with no cameras.

afterEach(cleanup)

const area = {
  id: "a1",
  kind: "area",
  name: "ASB1",
  points: [
    [0, 0],
    [4, 0],
    [4, 4],
    [0, 4],
  ],
  room: null,
  location: null,
} as unknown as AreaShape

function show(coverage: number | null) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <AreaPanel area={area} coverage={coverage} onClose={() => undefined} />
      </TooltipProvider>
    </QueryClientProvider>
  )
}

describe("AreaPanel camera coverage", () => {
  it("shows the share beside its label", () => {
    show(0.42)
    const label = screen.getByText("Camera coverage")
    expect(label.parentElement?.textContent).toBe("Camera coverage42%")
  })

  it("shows a camera that sees none of it as 0%", () => {
    show(0)
    expect(screen.getByText("0%")).toBeTruthy()
  })

  it("leaves the row out with no cameras", () => {
    show(null)
    expect(screen.queryByText("Camera coverage")).toBeNull()
  })
})
