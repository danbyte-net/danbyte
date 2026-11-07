// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SummaryMembers3D, createSummaryStore } from "./summary-picker"
import type { SceneTile } from "./world"

// A summary plate in the room: its hover lists the members, a click opens
// the panel - pick one to go to it, or zoom to them all. The selected one
// is never listed: it draws on its own plate.

const tile = (id: string, kind: SceneTile["kind"], label: string) =>
  ({ id, kind, label, color: "#3f3f46", x: 0, y: 0, w: 1, h: 1 }) as SceneTile

const tiles = [
  tile("r1", "rack", "R-01"),
  tile("r2", "rack", "R-02"),
  tile("d1", "device", "SW-1"),
]
const hit = {
  id: "crowd:d1",
  name: "3 objects",
  members: ["r1", "r2", "d1"],
  x: 100,
  y: 100,
}

afterEach(cleanup)

describe("SummaryMembers3D", () => {
  it("keeps the hover card on one plate and drops repeat hovers", () => {
    const store = createSummaryStore()
    const seen = vi.fn()
    store.subscribe(seen)
    store.hover(hit)
    store.hover({ ...hit, x: 140 })
    expect(seen).toHaveBeenCalledTimes(1)
    expect(store.get().hover?.x).toBe(100)
    store.hover(null)
    expect(store.get().hover).toBeNull()
  })

  it("opens the panel grouped by kind, without the selected member", () => {
    const store = createSummaryStore()
    const onPick = vi.fn()
    const onZoom = vi.fn()
    render(
      <SummaryMembers3D
        store={store}
        tiles={tiles}
        nameOf={(t) => t.label}
        selected="r2"
        onPick={onPick}
        onZoom={onZoom}
      />
    )
    act(() => store.open(hit))
    const panel = screen.getByRole("dialog", { name: "Cluster" })
    expect(panel.textContent).toContain("Racks")
    expect(panel.textContent).toContain("Devices")
    expect(panel.textContent).toContain("R-01")
    expect(panel.textContent).not.toContain("R-02")

    fireEvent.click(screen.getByRole("button", { name: /Zoom to these/ }))
    expect(onZoom).toHaveBeenCalledWith(["r1", "d1"])
    expect(store.get().open).toBeNull()
  })

  it("picks a member and closes", () => {
    const store = createSummaryStore()
    const onPick = vi.fn()
    render(
      <SummaryMembers3D
        store={store}
        tiles={tiles}
        nameOf={(t) => t.label}
        selected={null}
        onPick={onPick}
        onZoom={() => {}}
      />
    )
    act(() => store.open(hit))
    fireEvent.click(screen.getByRole("button", { name: /SW-1/ }))
    expect(onPick).toHaveBeenCalledWith("d1")
    expect(store.get().open).toBeNull()
  })

  it("searches a cluster past the hover's cap", () => {
    const many = Array.from({ length: 15 }, (_, i) =>
      tile(`r${i}`, "rack", `R-${String(i).padStart(2, "0")}`)
    )
    const store = createSummaryStore()
    render(
      <SummaryMembers3D
        store={store}
        tiles={many}
        nameOf={(t) => t.label}
        selected={null}
        onPick={() => {}}
        onZoom={() => {}}
      />
    )
    act(() =>
      store.open({ ...hit, name: "15 racks", members: many.map((t) => t.id) })
    )
    const search = screen.getByRole("textbox", { name: "Search members" })
    fireEvent.change(search, { target: { value: "R-1" } })
    const panel = screen.getByRole("dialog", { name: "Cluster" })
    expect(panel.querySelectorAll("[data-member]")).toHaveLength(5)
  })
})
