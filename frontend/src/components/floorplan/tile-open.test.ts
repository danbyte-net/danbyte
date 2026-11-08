// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { FloorPlanLinkKind, FloorPlanTile } from "@/lib/api"

import { applyPick } from "./plan-search"
import { LINK_KIND_NAME, LINK_OPENS, tileOpen } from "./tile-open"
import { useTilePopover } from "./tile-popover"

// Every link kind has a way in: a click, a Find pick or an Objects pick
// opens its panel, its plan or its pinned popover - never only a selection
// nobody can see (cooling sources and power panels once did nothing).

const KINDS = Object.keys(LINK_OPENS) as FloorPlanLinkKind[]

const tileOf = (kind: FloorPlanLinkKind | null, hidden = false) =>
  ({
    id: `t-${kind ?? "none"}`,
    x: 1,
    y: 2,
    width: 1,
    height: 1,
    label: "",
    linked: kind
      ? {
          kind,
          id: hidden ? null : `o-${kind}`,
          name: hidden ? "Hidden" : kind,
          hidden,
        }
      : null,
  }) as unknown as FloorPlanTile

const actions = () => ({
  openCable: vi.fn(),
  highlightTray: vi.fn(),
  showArea: vi.fn(),
  showTile: vi.fn(),
  openTilePanel: vi.fn(),
  pinTile: vi.fn(),
})

describe("tileOpen", () => {
  it("covers every link kind the API has", () => {
    expect(KINDS.sort()).toEqual(
      [
        "cabinet",
        "coolingsource",
        "device",
        "floorplan",
        "powerfeed",
        "powerpanel",
        "rack",
      ].sort()
    )
    for (const k of KINDS) expect(LINK_KIND_NAME[k].one).toBeTruthy()
  })

  it.each(KINDS)("%s opens its plan, panel or popover", (kind) => {
    const how = tileOpen(tileOf(kind))
    expect(how.kind).toBe(LINK_OPENS[kind])
    if (how.kind === "plan") expect(how.id).toBe("o-floorplan")
  })

  it("cooling sources and power pin their popover", () => {
    for (const k of ["coolingsource", "powerpanel", "powerfeed"] as const)
      expect(tileOpen(tileOf(k)).kind).toBe("popover")
  })

  it("an unlinked or Hidden tile pins its popover", () => {
    expect(tileOpen(tileOf(null)).kind).toBe("popover")
    for (const k of KINDS)
      expect(tileOpen(tileOf(k, true)).kind).toBe("popover")
  })
})

describe("applyPick on an object", () => {
  it.each(KINDS)("viewing, %s opens like a click", (kind) => {
    const acts = actions()
    const tile = tileOf(kind)
    applyPick({ kind: "object", id: tile.id, tile }, acts, { editing: false })
    expect(acts.showTile).toHaveBeenCalledWith(tile)
    const panel = LINK_OPENS[kind] === "panel"
    expect(acts.openTilePanel).toHaveBeenCalledTimes(panel ? 1 : 0)
    expect(acts.pinTile).toHaveBeenCalledTimes(panel ? 0 : 1)
  })

  it.each(KINDS)("editing, %s only selects", (kind) => {
    const acts = actions()
    const tile = tileOf(kind)
    applyPick({ kind: "object", id: tile.id, tile }, acts, { editing: true })
    expect(acts.showTile).toHaveBeenCalledWith(tile)
    expect(acts.openTilePanel).not.toHaveBeenCalled()
    expect(acts.pinTile).not.toHaveBeenCalled()
  })
})

describe("useTilePopover.pinTile", () => {
  it("pins at the pointer while it is over the tile", () => {
    const { result } = renderHook(() => useTilePopover())
    const tile = tileOf("coolingsource")
    act(() => result.current.onHover(tile, { x: 10, y: 20 }))
    // A view-mode click closes the preview first, then opens the tile.
    act(() => result.current.close())
    act(() => {
      result.current.pinTile(tile, { x: 99, y: 99 })
    })
    expect(result.current.target).toMatchObject({
      tile,
      x: 10,
      y: 20,
      pinned: true,
    })
  })

  it("pins at the given point for a pick from a list", () => {
    const { result } = renderHook(() => useTilePopover())
    const tile = tileOf("powerpanel")
    act(() => result.current.onHover(tileOf("rack"), { x: 1, y: 1 }))
    let ok = false
    act(() => {
      ok = result.current.pinTile(tile, { x: 50, y: 60 })
    })
    expect(ok).toBe(true)
    expect(result.current.target).toMatchObject({
      tile,
      x: 50,
      y: 60,
      pinned: true,
    })
  })

  it("has nowhere to pin without a point or the pointer", () => {
    const { result } = renderHook(() => useTilePopover())
    let ok = true
    act(() => {
      ok = result.current.pinTile(tileOf("powerfeed"))
    })
    expect(ok).toBe(false)
    expect(result.current.target).toBeNull()
  })

  it("a pinned popover ignores hover", () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useTilePopover())
    const tile = tileOf("coolingsource")
    act(() => {
      result.current.pinTile(tile, { x: 5, y: 5 })
    })
    act(() => result.current.onHover(tileOf("rack"), { x: 1, y: 1 }))
    act(() => vi.advanceTimersByTime(1000))
    expect(result.current.target?.tile).toBe(tile)
    vi.useRealTimers()
  })
})
