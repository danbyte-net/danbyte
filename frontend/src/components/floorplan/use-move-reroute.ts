import { useCallback, useEffect, useRef, useState } from "react"

import type { FloorPlanCablePath } from "@/lib/api"

import {
  changedTrayIds,
  mergeIds,
  movedTileIds,
  routesTouched,
} from "./cable-reroute"
import type { PlanDraftApi } from "./edit-history"
import type { EditTile } from "./use-plan-edit-state"
import type { PlanShape } from "./shapes"
import type { StructShape } from "./structure"

/** The **Update N routes?** prompt: the cables to route again, and the
 * draft step they belong to (`rev`) - applying folds the new routes into
 * that step, so undoing the move undoes them too. `rev` null: a step of
 * its own (out-of-date routes found after a move made elsewhere). */
export interface ReroutePrompt {
  cableIds: string[]
  rev: number | null
}

/**
 * Watches the draft for a finished step (a drag once the pointer lifts, a
 * nudge, an align, a room moved) that moved tiles or changed trays stored
 * routes use, and offers to route them again. Undo, redo or a reload drop
 * the prompt of a step; a step that touched no route keeps the prompt.
 */
export function useMoveReroute({
  draft,
  cablePaths,
  enabled,
}: {
  draft: PlanDraftApi<EditTile, PlanShape, StructShape>
  /** The plan's cables with the draft's routes. */
  cablePaths: readonly FloorPlanCablePath[]
  enabled: boolean
}) {
  const [prompt, setPrompt] = useState<ReroutePrompt | null>(null)
  const paths = useRef(cablePaths)
  paths.current = cablePaths
  const seen = useRef(-1)
  const skip = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setPrompt(null)
      return
    }
    if (draft.gesturing || seen.current === draft.rev) return
    seen.current = draft.rev
    if (draft.last === "amend") return
    if (draft.last !== "do") {
      setPrompt((p) => (p && p.rev !== null ? null : p))
      return
    }
    if (skip.current) {
      skip.current = false
      return
    }
    const before = draft.before
    if (!before) return
    const ids = routesTouched(
      paths.current,
      draft.tiles,
      movedTileIds(before.tiles, draft.tiles),
      changedTrayIds(before.structure, draft.structure)
    )
    if (!ids.length) return
    setPrompt((p) => ({
      cableIds: mergeIds(p?.cableIds, ids),
      rev: draft.rev,
    }))
  }, [
    enabled,
    draft.rev,
    draft.gesturing,
    draft.last,
    draft.before,
    draft.tiles,
    draft.structure,
  ])

  /** The next step is not asked about (a drop - After placing asks). */
  const skipNext = useCallback(() => {
    skip.current = true
  }, [])

  return { prompt, setPrompt, skipNext }
}
