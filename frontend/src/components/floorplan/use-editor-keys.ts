import { useEffect } from "react"
import type { RefObject } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { FloorPlan } from "@/lib/api"
import { useHideKeys } from "@/components/hidden-objects"
import { useDocumentKeys } from "@/components/topology/view-document"

import { NO_FLOOR_HIDDEN } from "./hidden"
import type { PlanEditState } from "./use-plan-edit-state"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import type { StructureEdits } from "./use-structure-edits"
import type { TileEdits } from "./use-tile-edits"

/** The editor's keyboard: H / Shift+H hide and show, Delete, Escape,
 * arrows, Enter to finish a polyline, and the document keys (undo, redo,
 * save). */
export function useEditorKeys({
  canEdit,
  view3d,
  traceParam,
  tracedRef,
  plan,
  ed,
  edits,
  structure,
  prefs,
  hiddenTileIds,
  closePopover,
}: {
  canEdit: boolean
  view3d: boolean
  traceParam: string | undefined
  /** The trace the page last focused - cleared when Esc stops it. */
  tracedRef: RefObject<string | null>
  plan: FloorPlan | undefined
  ed: PlanEditState
  edits: TileEdits
  structure: StructureEdits
  prefs: PlanViewPrefs
  hiddenTileIds: Set<string>
  closePopover: () => void
}) {
  const nav = useNavigate()
  const {
    draft,
    tiles,
    isDirty,
    selectedId,
    setSelectedId,
    multiSel,
    setMultiSel,
    setArmed,
    areaArmed,
    setAreaArmed,
    setSelectedWallId,
    doorArmed,
    setDoorArmed,
    setCabinetTileId,
    setHighlightCableIds,
    trayEditMode,
    setTrayEditMode,
    mode,
    setSelectedTrayId,
    drawPoints,
    setDrawPoints,
  } = ed
  const { deleteTile, changeTileGuarded, moveSelectionBy, save } = edits
  const { finishDraw } = structure
  const { hidden, setHiddenPref } = prefs

  // H hides the selected tile(s) as their eyes would; Shift+H shows all.
  const hideKeyIds = [...(selectedId ? [selectedId] : []), ...multiSel].filter(
    (id) => !hiddenTileIds.has(id)
  )
  useHideKeys(
    hideKeyIds.length && !view3d
      ? () => {
          setHiddenPref({
            ...hidden,
            tiles: [...new Set([...hidden.tiles, ...hideKeyIds])],
          })
          setSelectedId(null)
          setMultiSel(new Set())
        }
      : null,
    () => setHiddenPref(NO_FLOOR_HIDDEN)
  )

  // Keyboard: Delete removes the selection, Escape disarms/deselects,
  // arrows nudge. Skipped while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Escape") {
        // An active ?trace= wins: first Esc stops the trace (2D and 3D).
        if (traceParam) {
          void nav({
            to: ".",
            search: (s: Record<string, unknown>) => ({
              ...s,
              trace: undefined,
            }),
            replace: true,
          })
          setHighlightCableIds([])
          tracedRef.current = null
          return
        }
        // In tray edit mode? First Esc just leaves it.
        if (trayEditMode) {
          setTrayEditMode(false)
          return
        }
        setArmed(null)
        setSelectedId(null)
        setSelectedTrayId(null)
        setSelectedWallId(null)
        setDrawPoints(null)
        setCabinetTileId(null)
        return
      }
      if (e.key === "Escape" && doorArmed) {
        setDoorArmed(false)
        return
      }
      if (e.key === "Escape" && areaArmed) {
        setAreaArmed(false)
        return
      }
      if (e.key === "Escape" && multiSel.size > 0) {
        setMultiSel(new Set())
        return
      }
      // Enter finishes an in-progress polyline (tray or wall).
      if (
        (mode === "cable" || mode === "structure") &&
        drawPoints !== null &&
        e.key === "Enter"
      ) {
        e.preventDefault()
        finishDraw()
        return
      }
      // In the 3D view the camera rig owns arrows (and a 2D tile selection
      // is invisible) - don't nudge/delete a tile nobody can see.
      if (!canEdit || view3d) return
      // A selection of several: Delete removes them all, arrows move them
      // as one.
      if (multiSel.size > 1 && mode === "layout") {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault()
          for (const tid of multiSel) deleteTile(tid)
          setMultiSel(new Set())
        } else if (e.key.startsWith("Arrow")) {
          e.preventDefault()
          moveSelectionBy(
            e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0,
            e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
          )
        }
        return
      }
      if (!selectedId) return
      const tile = tiles.find((t) => t.id === selectedId)
      if (!tile || !plan) return
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault()
        deleteTile(selectedId)
      } else if (e.key.startsWith("Arrow")) {
        e.preventDefault()
        const dx = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0
        const dy = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
        changeTileGuarded(selectedId, {
          x: Math.max(0, Math.min(plan.grid_width - tile.width, tile.x + dx)),
          y: Math.max(0, Math.min(plan.grid_height - tile.height, tile.y + dy)),
        })
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [
    canEdit,
    selectedId,
    tiles,
    plan,
    deleteTile,
    changeTileGuarded,
    mode,
    drawPoints,
    finishDraw,
    trayEditMode,
    traceParam,
    nav,
    view3d,
    areaArmed,
    doorArmed,
    multiSel,
    moveSelectionBy,
  ])

  // Ctrl/⌘+Z undoes a tile edit, Shift+Ctrl/⌘+Z or Ctrl+Y redoes it, and
  // Ctrl/⌘+S saves - the topology map's keys.
  const stepHistory = (dir: "undo" | "redo") => {
    if (dir === "undo" ? draft.undo() : draft.redo()) closePopover()
  }
  useDocumentKeys({
    enabled: canEdit,
    onSave: () => {
      if (isDirty && !save.isPending) save.mutate()
      return true
    },
    onUndo: () => stepHistory("undo"),
    onRedo: () => stepHistory("redo"),
  })

  return { stepHistory }
}
