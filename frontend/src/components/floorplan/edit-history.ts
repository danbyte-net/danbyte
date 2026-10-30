import { useCallback, useReducer, useRef } from "react"
import type { SetStateAction } from "react"

/**
 * The floor plan editor's draft with its undo history - the topology map's
 * `view-document.ts` pattern for the plan's tiles and shapes (areas and
 * labels). The draft is what Save writes in one bulk call: the tiles and
 * shapes as edited, which of them changed and which were deleted (one set
 * each, keyed by id - ids never repeat across kinds). Every edit is one step back (at most `HISTORY_LIMIT`);
 * the setters called inside one event handler are one step, and so is a
 * whole drag (`gesture`, sealed when the pointer lifts).
 *
 * Saving starts a fresh history: the save gives new tiles their real ids,
 * so a step from before it would bring back a tile that no longer exists.
 */
export const HISTORY_LIMIT = 100

export interface PlanDraft<T, TShape = unknown> {
  tiles: T[]
  shapes: TShape[]
  dirty: ReadonlySet<string>
  deleted: ReadonlySet<string>
}

export interface DraftHistory<T, TShape = unknown> {
  past: PlanDraft<T, TShape>[]
  present: PlanDraft<T, TShape>
  future: PlanDraft<T, TShape>[]
  /** The coalescing key of the last step. */
  step: string | null
}

export type DraftMsg<T, TShape = unknown> =
  | {
      kind: "do"
      apply: (d: PlanDraft<T, TShape>) => PlanDraft<T, TShape>
      step?: string
    }
  | { kind: "undo" }
  | { kind: "redo" }
  /** Close the current step: the next edit is a step of its own. */
  | { kind: "seal" }
  /** Fresh data from the server, or after a save: history forgotten. */
  | { kind: "load"; draft: PlanDraft<T, TShape> }

export function emptyDraft<T, TShape = unknown>(
  tiles: T[] = [],
  shapes: TShape[] = []
): PlanDraft<T, TShape> {
  return { tiles, shapes, dirty: new Set(), deleted: new Set() }
}

export function initDraftHistory<T, TShape = unknown>(
  draft: PlanDraft<T, TShape>
): DraftHistory<T, TShape> {
  return { past: [], present: draft, future: [], step: null }
}

export function draftReducer<T, TShape = unknown>(
  h: DraftHistory<T, TShape>,
  m: DraftMsg<T, TShape>
): DraftHistory<T, TShape> {
  switch (m.kind) {
    case "do": {
      const next = m.apply(h.present)
      if (
        next === h.present ||
        (next.tiles === h.present.tiles &&
          next.shapes === h.present.shapes &&
          next.dirty === h.present.dirty &&
          next.deleted === h.present.deleted)
      )
        return h
      if (m.step && m.step === h.step && h.past.length)
        return { ...h, present: next, future: [] }
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        step: m.step ?? null,
      }
    }
    case "undo": {
      const prev = h.past.at(-1)
      if (!prev) return h
      return {
        past: h.past.slice(0, -1),
        present: prev,
        future: [h.present, ...h.future],
        step: null,
      }
    }
    case "redo": {
      const next = h.future.at(0)
      if (!next) return h
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: h.future.slice(1),
        step: null,
      }
    }
    case "seal":
      return h.step === null ? h : { ...h, step: null }
    case "load":
      return initDraftHistory(m.draft)
  }
}

const resolve = <TState>(v: SetStateAction<TState>, prev: TState): TState =>
  typeof v === "function" ? (v as (p: TState) => TState)(prev) : v

export interface PlanDraftApi<T, TShape = unknown> {
  tiles: T[]
  shapes: TShape[]
  dirtyIds: ReadonlySet<string>
  deletedIds: ReadonlySet<string>
  setTiles: (v: SetStateAction<T[]>) => void
  setShapes: (v: SetStateAction<TShape[]>) => void
  setDirtyIds: (v: SetStateAction<ReadonlySet<string>>) => void
  setDeletedIds: (v: SetStateAction<ReadonlySet<string>>) => void
  /** Edits until `endGesture` are one step (a drag). */
  beginGesture: () => void
  endGesture: () => void
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  /** Replace the draft and forget the history. */
  load: (tiles: T[], shapes?: TShape[]) => void
  /** The rows as last loaded - what the edits are based on (their
   * versions go with a save, so a row changed elsewhere since is a
   * conflict rather than overwritten). */
  origin: { tiles: T[]; shapes: TShape[] }
}

/** The page's handle on the draft. */
export function usePlanDraft<T, TShape = unknown>(): PlanDraftApi<T, TShape> {
  const [h, send] = useReducer(draftReducer<T, TShape>, undefined, () =>
    initDraftHistory(emptyDraft<T, TShape>())
  )
  const latest = useRef(h)
  latest.current = h
  const origin = useRef<{ tiles: T[]; shapes: TShape[] }>({
    tiles: [],
    shapes: [],
  })

  // One handler = one step: calls inside the same task share a key; the
  // microtask closes the window after the handler. A gesture holds one key
  // across tasks until it ends.
  const tick = useRef({ n: 0, open: false, gesture: null as string | null })
  const stepKey = useCallback(() => {
    const t = tick.current
    if (t.gesture) return t.gesture
    if (!t.open) {
      t.n += 1
      t.open = true
      queueMicrotask(() => {
        t.open = false
      })
    }
    return `tick#${t.n}`
  }, [])

  const edit = useCallback(
    (apply: (d: PlanDraft<T, TShape>) => PlanDraft<T, TShape>) =>
      send({ kind: "do", apply, step: stepKey() }),
    [stepKey]
  )
  const setTiles = useCallback(
    (v: SetStateAction<T[]>) =>
      edit((d) => {
        const tiles = resolve(v, d.tiles)
        return tiles === d.tiles ? d : { ...d, tiles }
      }),
    [edit]
  )
  const setShapes = useCallback(
    (v: SetStateAction<TShape[]>) =>
      edit((d) => {
        const shapes = resolve(v, d.shapes)
        return shapes === d.shapes ? d : { ...d, shapes }
      }),
    [edit]
  )
  const setDirtyIds = useCallback(
    (v: SetStateAction<ReadonlySet<string>>) =>
      edit((d) => {
        const dirty = resolve(v, d.dirty)
        return dirty === d.dirty ? d : { ...d, dirty }
      }),
    [edit]
  )
  const setDeletedIds = useCallback(
    (v: SetStateAction<ReadonlySet<string>>) =>
      edit((d) => {
        const deleted = resolve(v, d.deleted)
        return deleted === d.deleted ? d : { ...d, deleted }
      }),
    [edit]
  )
  const beginGesture = useCallback(() => {
    const t = tick.current
    t.n += 1
    t.gesture = `gesture#${t.n}`
  }, [])
  const endGesture = useCallback(() => {
    tick.current.gesture = null
    send({ kind: "seal" })
  }, [])
  const undo = useCallback(() => {
    if (!latest.current.past.length) return false
    send({ kind: "undo" })
    return true
  }, [])
  const redo = useCallback(() => {
    if (!latest.current.future.length) return false
    send({ kind: "redo" })
    return true
  }, [])
  const load = useCallback((tiles: T[], shapes: TShape[] = []) => {
    origin.current = { tiles, shapes }
    send({ kind: "load", draft: emptyDraft(tiles, shapes) })
  }, [])
  return {
    tiles: h.present.tiles,
    shapes: h.present.shapes,
    dirtyIds: h.present.dirty,
    deletedIds: h.present.deleted,
    setTiles,
    setShapes,
    setDirtyIds,
    setDeletedIds,
    beginGesture,
    endGesture,
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    load,
    origin: origin.current,
  }
}
