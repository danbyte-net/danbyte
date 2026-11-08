// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanCablePath, FloorPlanTile } from "@/lib/api"

import { applyPick } from "./plan-search"
import type { PlanHit } from "./plan-search"
import { PlanSearch } from "./tile-search"

// "Find on plan…" lists hits grouped by kind, walks them with the arrow
// keys, and a picked cable is traced, framed and opened in its panel.

afterEach(cleanup)

const CABLE = {
  id: "c1",
  label: "PATCH-01",
  a_tiles: [],
  b_tiles: [],
  a_points: [{ device: "d1", port: "Gi1/0/1", device_name: "sw1" }],
  b_points: [{ device: "d2", port: "eth0", device_name: "srv" }],
  tray_ids: [],
} as unknown as FloorPlanCablePath

const TILE = {
  id: "t1",
  label: "sw1",
  linked: { kind: "device", id: "d1", name: "sw1" },
} as FloorPlanTile

const SEARCH_IN = { tiles: [TILE], cables: [CABLE], trays: [], shapes: [] }

function Harness({ onPick }: { onPick: (h: PlanHit) => void }) {
  return (
    <PlanSearch
      searchIn={SEARCH_IN}
      value="sw1"
      onChange={() => undefined}
      onPick={onPick}
    />
  )
}

describe("PlanSearch", () => {
  it("groups the hits and picks with the keyboard", () => {
    const onPick = vi.fn()
    render(<Harness onPick={onPick} />)
    const input = screen.getByRole("combobox", { name: "Find on plan" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    expect(screen.getByRole("group", { name: "Objects" })).toBeTruthy()
    expect(screen.getByRole("group", { name: "Cables" })).toBeTruthy()
    // The first hit was active; one step down is the cable.
    const options = screen.getAllByRole("option")
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
    ])
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "cable", id: "c1" })
    )
  })
})

describe("applyPick", () => {
  const acts = () => ({
    openCable: vi.fn(),
    highlightTray: vi.fn(),
    showArea: vi.fn(),
    showTile: vi.fn(),
    openTilePanel: vi.fn(),
    pinTile: vi.fn(),
  })

  it("traces, frames and opens a cable", () => {
    const a = acts()
    applyPick({ kind: "cable", id: "c1", cable: CABLE, match: "" }, a, {
      editing: false,
    })
    expect(a.openCable).toHaveBeenCalledWith("c1", true)
  })

  it("frames an object, opening a device's panel only while viewing", () => {
    const a = acts()
    const hit: PlanHit = { kind: "object", id: "t1", tile: TILE }
    applyPick(hit, a, { editing: false })
    expect(a.showTile).toHaveBeenCalledWith(TILE)
    expect(a.openTilePanel).toHaveBeenCalledWith(TILE)
    const b = acts()
    applyPick(hit, b, { editing: true })
    expect(b.showTile).toHaveBeenCalled()
    expect(b.openTilePanel).not.toHaveBeenCalled()
  })

  it("lights a tray", () => {
    const a = acts()
    applyPick({ kind: "tray", id: "tr1", tray: {} as never }, a, {
      editing: false,
    })
    expect(a.highlightTray).toHaveBeenCalledWith("tr1")
  })
})
