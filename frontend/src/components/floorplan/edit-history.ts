import { useCallback, useReducer, useRef, useState } from "react"
import type { SetStateAction } from "react"

import { EMPTY_CABLE_DRAFT } from "./cable-draft"
import type { CableDraft } from "./cable-draft"

/**
 * The floor plan editor's draft with its undo history - the topology map's
 * `view-document.ts` pattern for the plan's tiles, shapes (areas and
 * labels) and structure (walls, raised floors, trays). The draft is what
 * Save writes in one bulk call: the rows as edited, which of them changed
 * and which were deleted (one set each, keyed by id - ids never repeat
 * across kinds). Every edit is one step back (at most `HISTORY_LIMIT`);
 * the setters called inside one event handler are one step, and so is a
 * whole drag (`gesture`, sealed when the pointer lifts).
 *
 * Saving starts a fresh history: the save gives new tiles their real ids,
 * so a step from before it would bring back a tile that no longer exists.
 *
 * `amend` folds an edit into the step it names (by `rev`): re-routing the
 * cables of a move is part of the move, so one undo takes back both.
 */
export const HISTORY_LIMIT = 100

export interface PlanDraft<T, TShape = unknown, TStruct = unknown> {
  tiles: T[]
  shapes: TShape[]
  /** Walls, raised floors and trays. */
  structure: TStruct[]
  dirty: ReadonlySet<string>
  deleted: ReadonlySet<string>
  /** Cable routes applied from "After placing" (cable-draft.ts). */
  cables: CableDraft
}

export interface DraftHistory<T, TShape = unknown, TStruct = unknown> {
  past: PlanDraft<T, TShape, TStruct>[]
  present: PlanDraft<T, TShape, TStruct>
  future: PlanDraft<T, TShape, TStruct>[]
  /** The coalescing key of the last step. */
  step: string | null
  /** Bumped whenever `present` changes. */
  rev: number
  /** What changed `present` last. */
  last: "do" | "amend" | "undo" | "redo" | "load"
}

export type DraftMsg<T, TShape = unknown, TStruct = unknown> =
  | {
      kind: "do"
      apply: (d: PlanDraft<T, TShape, TStruct>) => PlanDraft<T, TShape, TStruct>
      step?: string
    }
  | { kind: "undo" }
  | { kind: "redo" }
  /** Fold an edit into the step that left the draft at `rev`; a draft
   * changed since takes it as a step of its own. */
  | {
      kind: "amend"
      apply: (d: PlanDraft<T, TShape, TStruct>) => PlanDraft<T, TShape, TStruct>
      rev: number
    }
  /** Close the current step: the next edit is a step of its own. */
  | { kind: "seal" }
  /** Fresh data from the server, or after a save: history forgotten. */
  | { kind: "load"; draft: PlanDraft<T, TShape, TStruct> }

export function emptyDraft<T, TShape = unknown, TStruct = unknown>(
  tiles: T[] = [],
  shapes: TShape[] = [],
  structure: TStruct[] = []
): PlanDraft<T, TShape, TStruct> {
  return {
    tiles,
    shapes,
    structure,
    dirty: new Set(),
    deleted: new Set(),
    cables: EMPTY_CABLE_DRAFT,
  }
}

export function initDraftHistory<T, TShape = unknown, TStruct = unknown>(
  draft: PlanDraft<T, TShape, TStruct>
): DraftHistory<T, TShape, TStruct> {
  return {
    past: [],
    present: draft,
    future: [],
    step: null,
    rev: 0,
    last: "load",
  }
}

export function draftReducer<T, TShape = unknown, TStruct = unknown>(
  h: DraftHistory<T, TShape, TStruct>,
  m: DraftMsg<T, TShape, TStruct>
): DraftHistory<T, TShape, TStruct> {
  switch (m.kind) {
    case "do": {
      const next = m.apply(h.present)
      if (unchanged(next, h.present)) return h
      if (m.step && m.step === h.step && h.past.length)
        return { ...h, present: next, future: [], rev: h.rev + 1, last: "do" }
      return {
        past: [...h.past, h.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        step: m.step ?? null,
        rev: h.rev + 1,
        last: "do",
      }
    }
    case "amend": {
      if (m.rev !== h.rev || !h.past.length)
        return draftReducer(h, { kind: "do", apply: m.apply })
      const next = m.apply(h.present)
      if (unchanged(next, h.present)) return h
      return {
        ...h,
        present: next,
        future: [],
        step: null,
        rev: h.rev + 1,
        last: "amend",
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
        rev: h.rev + 1,
        last: "undo",
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
        rev: h.rev + 1,
        last: "redo",
      }
    }
    case "seal":
      return h.step === null ? h : { ...h, step: null }
    case "load":
      return { ...initDraftHistory(m.draft), rev: h.rev + 1 }
  }
}

function unchanged<T, TShape, TStruct>(
  next: PlanDraft<T, TShape, TStruct>,
  cur: PlanDraft<T, TShape, TStruct>
): boolean {
  return (
    next === cur ||
    (next.tiles === cur.tiles &&
      next.shapes === cur.shapes &&
      next.structure === cur.structure &&
      next.dirty === cur.dirty &&
      next.deleted === cur.deleted &&
      next.cables === cur.cables)
  )
}

const resolve = <TState>(v: SetStateAction<TState>, prev: TState): TState =>
  typeof v === "function" ? (v as (p: TState) => TState)(prev) : v

export interface PlanDraftApi<T, TShape = unknown, TStruct = unknown> {
  tiles: T[]
  shapes: TShape[]
  dirtyIds: ReadonlySet<string>
  deletedIds: ReadonlySet<string>
  setTiles: (v: SetStateAction<T[]>) => void
  setShapes: (v: SetStateAction<TShape[]>) => void
  structure: TStruct[]
  setStructure: (v: SetStateAction<TStruct[]>) => void
  setDirtyIds: (v: SetStateAction<ReadonlySet<string>>) => void
  setDeletedIds: (v: SetStateAction<ReadonlySet<string>>) => void
  cables: CableDraft
  setCables: (v: SetStateAction<CableDraft>) => void
  /** Edits until `endGesture` are one step (a drag). */
  beginGesture: () => void
  endGesture: () => void
  /** A drag is under way: its step is not finished. */
  gesturing: boolean
  /** Bumped whenever the draft changes. */
  rev: number
  /** What changed the draft last. */
  last: DraftHistory<T, TShape, TStruct>["last"]
  /** The draft before the last step (undefined with no history). */
  before: PlanDraft<T, TShape, TStruct> | undefined
  /** Fold an edit into the step that left the draft at `rev` (else it is
   * a step of its own). */
  amend: (
    apply: (d: PlanDraft<T, TShape, TStruct>) => PlanDraft<T, TShape, TStruct>,
    rev: number
  ) => void
  undo: () => boolean
  redo: () => boolean
  canUndo: boolean
  canRedo: boolean
  /** Replace the draft and forget the history. */
  load: (tiles: T[], shapes?: TShape[], structure?: TStruct[]) => void
  /** The rows as last loaded - what the edits are based on (their
   * versions go with a save, so a row changed elsewhere since is a
   * conflict rather than overwritten). */
  origin: { tiles: T[]; shapes: TShape[]; structure: TStruct[] }
}

/** The page's handle on the draft. */
export function usePlanDraft<
  T,
  TShape = unknown,
  TStruct = unknown,
>(): PlanDraftApi<T, TShape, TStruct> {
  const [h, send] = useReducer(
    draftReducer<T, TShape, TStruct>,
    undefined,
    () => initDraftHistory(emptyDraft<T, TShape, TStruct>())
  )
  const latest = useRef(h)
  latest.current = h
  const origin = useRef<{
    tiles: T[]
    shapes: TShape[]
    structure: TStruct[]
  }>({
    tiles: [],
    shapes: [],
    structure: [],
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
    (
      apply: (d: PlanDraft<T, TShape, TStruct>) => PlanDraft<T, TShape, TStruct>
    ) => send({ kind: "do", apply, step: stepKey() }),
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
  const setStructure = useCallback(
    (v: SetStateAction<TStruct[]>) =>
      edit((d) => {
        const structure = resolve(v, d.structure)
        return structure === d.structure ? d : { ...d, structure }
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
  const setCables = useCallback(
    (v: SetStateAction<CableDraft>) =>
      edit((d) => {
        const cables = resolve(v, d.cables)
        return cables === d.cables ? d : { ...d, cables }
      }),
    [edit]
  )
  const [gesturing, setGesturing] = useState(false)
  const beginGesture = useCallback(() => {
    const t = tick.current
    t.n += 1
    t.gesture = `gesture#${t.n}`
    setGesturing(true)
  }, [])
  const endGesture = useCallback(() => {
    tick.current.gesture = null
    send({ kind: "seal" })
    setGesturing(false)
  }, [])
  const amend = useCallback(
    (
      apply: (
        d: PlanDraft<T, TShape, TStruct>
      ) => PlanDraft<T, TShape, TStruct>,
      rev: number
    ) => send({ kind: "amend", apply, rev }),
    []
  )
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
  const load = useCallback(
    (tiles: T[], shapes: TShape[] = [], structure: TStruct[] = []) => {
      origin.current = { tiles, shapes, structure }
      send({ kind: "load", draft: emptyDraft(tiles, shapes, structure) })
    },
    []
  )
  return {
    tiles: h.present.tiles,
    shapes: h.present.shapes,
    dirtyIds: h.present.dirty,
    deletedIds: h.present.deleted,
    setTiles,
    setShapes,
    structure: h.present.structure,
    setStructure,
    setDirtyIds,
    setDeletedIds,
    cables: h.present.cables,
    setCables,
    beginGesture,
    endGesture,
    gesturing,
    rev: h.rev,
    last: h.last,
    before: h.past.at(-1),
    amend,
    undo,
    redo,
    canUndo: h.past.length > 0,
    canRedo: h.future.length > 0,
    load,
    origin: origin.current,
  }
}
