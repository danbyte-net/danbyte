// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import {
  HISTORY_LIMIT,
  draftReducer,
  emptyDraft,
  initDraftHistory,
  usePlanDraft,
} from "./edit-history"
import type { DraftHistory } from "./edit-history"

// The floor plan editor's undo history: every edit a step, a handler's
// several setters one step, a drag one step, at most a hundred kept, and a
// load (fresh data, a save) a new start.

interface T {
  id: string
  x: number
}

const move =
  (id: string, x: number) => (d: ReturnType<typeof emptyDraft<T>>) => ({
    ...d,
    tiles: d.tiles.map((t) => (t.id === id ? { ...t, x } : t)),
    dirty: new Set(d.dirty).add(id),
  })

describe("draftReducer", () => {
  const start = (): DraftHistory<T> =>
    initDraftHistory(emptyDraft<T>([{ id: "a", x: 0 }]))

  it("steps back and forward", () => {
    let h = start()
    h = draftReducer(h, { kind: "do", apply: move("a", 1) })
    h = draftReducer(h, { kind: "do", apply: move("a", 2) })
    expect(h.present.tiles[0].x).toBe(2)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(1)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(0)
    expect(h.present.dirty.size).toBe(0)
    // Nothing further back.
    expect(draftReducer(h, { kind: "undo" })).toBe(h)
    h = draftReducer(h, { kind: "redo" })
    expect(h.present.tiles[0].x).toBe(1)
    // A new edit drops what could be redone.
    h = draftReducer(h, { kind: "do", apply: move("a", 5) })
    expect(h.future).toEqual([])
    expect(draftReducer(h, { kind: "redo" })).toBe(h)
  })

  it("a no-op is no step", () => {
    const h = start()
    expect(draftReducer(h, { kind: "do", apply: (d) => d })).toBe(h)
    expect(draftReducer(h, { kind: "do", apply: (d) => ({ ...d }) })).toBe(h)
  })

  it("edits sharing a step are one, until sealed", () => {
    let h = start()
    for (const x of [1, 2, 3])
      h = draftReducer(h, { kind: "do", apply: move("a", x), step: "drag" })
    expect(h.past).toHaveLength(1)
    h = draftReducer(h, { kind: "seal" })
    h = draftReducer(h, { kind: "do", apply: move("a", 4), step: "drag" })
    expect(h.past).toHaveLength(2)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(3)
    h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(0)
  })

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    let h = start()
    for (let x = 1; x <= HISTORY_LIMIT + 20; x++)
      h = draftReducer(h, { kind: "do", apply: move("a", x) })
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    while (h.past.length) h = draftReducer(h, { kind: "undo" })
    expect(h.present.tiles[0].x).toBe(20)
  })

  it("a load starts again", () => {
    let h = start()
    h = draftReducer(h, { kind: "do", apply: move("a", 1) })
    h = draftReducer(h, {
      kind: "load",
      draft: emptyDraft([{ id: "b", x: 9 }]),
    })
    expect(h.past).toEqual([])
    expect(h.present.tiles).toEqual([{ id: "b", x: 9 }])
  })
})

describe("usePlanDraft", () => {
  it("one handler's setters are one step", async () => {
    const { result } = renderHook(() => usePlanDraft<T>())
    act(() => result.current.load([{ id: "a", x: 0 }]))
    act(() => {
      result.current.setTiles((p) => p.map((t) => ({ ...t, x: 1 })))
      result.current.setDirtyIds((p) => new Set(p).add("a"))
    })
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      result.current.setDeletedIds(new Set(["z"]))
    })
    expect(result.current.deletedIds.has("z")).toBe(true)
    act(() => {
      result.current.undo()
    })
    expect(result.current.deletedIds.size).toBe(0)
    expect(result.current.tiles[0].x).toBe(1)
    act(() => {
      result.current.undo()
    })
    expect(result.current.tiles[0].x).toBe(0)
    expect(result.current.dirtyIds.size).toBe(0)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  it("a gesture is one step across handlers", async () => {
    const { result } = renderHook(() => usePlanDraft<T>())
    act(() => result.current.load([{ id: "a", x: 0 }]))
    act(() => result.current.beginGesture())
    for (const x of [1, 2, 3]) {
      act(() => result.current.setTiles([{ id: "a", x }]))
      await act(async () => {
        await Promise.resolve()
      })
    }
    act(() => result.current.endGesture())
    act(() => result.current.setTiles([{ id: "a", x: 7 }]))
    act(() => {
      result.current.undo()
    })
    expect(result.current.tiles[0].x).toBe(3)
    act(() => {
      result.current.undo()
    })
    expect(result.current.tiles[0].x).toBe(0)
    expect(result.current.undo()).toBe(false)
  })
})
