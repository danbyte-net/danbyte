import { useEffect } from "react"
import type { RefObject } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { FloorPlan } from "@/lib/api"
import { useHideKeys } from "@/components/hidden-objects"
import { useDocumentKeys } from "@/components/topology/view-document"

import type { FloorCanvasApi } from "./floor-canvas"
import { NO_FLOOR_HIDDEN } from "./hidden"
import { moveShapePatch, shapeBounds } from "./shapes"
import { toolForKey } from "./tool-rail"
import type { EditorTool, PlanEditState } from "./use-plan-edit-state"
import type { ShapeEdits } from "./use-shape-edits"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import type { StructureEdits } from "./use-structure-edits"
import type { TileEdits } from "./use-tile-edits"
import { slideDoor, translatePoints } from "./structure"

/** The drawing tools: Esc puts them down before it clears a selection. */
const DRAW_TOOLS: EditorTool[] = ["rect", "polygon", "label", "door"]

/** The editor's keyboard: E / Esc into and out of Edit, the tool keys,
 * H / Shift+H hide and show, Delete, Escape, arrows, Enter to finish a
 * polyline or polygon, Backspace to take back a polygon's point, Ctrl/⌘+[
 * and ] to restack an area or label, and the document keys (undo, redo,
 * save). */
export function useEditorKeys({
  canEdit,
  canToggleEdit = false,
  onToggleEdit,
  selectTool,
  shapeEdits,
  canvasApi,
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
  onPlaceKey,
}: {
  /** P: open the Place picker (switching to Edit first when it is off). */
  onPlaceKey?: () => void
  /** Edit is on: the plan may be changed from the keyboard. */
  canEdit: boolean
  /** May switch to Edit (E). */
  canToggleEdit?: boolean
  onToggleEdit?: (on: boolean) => void
  selectTool?: (tool: EditorTool) => void
  shapeEdits?: ShapeEdits
  canvasApi?: RefObject<FloorCanvasApi | null>
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
    shapes,
    selectedShapeId,
    setSelectedShapeId,
    tool,
    armed,
  } = ed
  const { deleteTile, changeTileGuarded, moveSelectionBy, save } = edits
  const { finishDraw } = structure
  const { hidden, setHiddenPref } = prefs
  const selectedShape = shapes.find((s) => s.id === selectedShapeId) ?? null

  // H hides the selected tile(s) - or area, or label - as their eyes would;
  // Shift+H shows all.
  const hideKeyIds = [...(selectedId ? [selectedId] : []), ...multiSel].filter(
    (id) => !hiddenTileIds.has(id)
  )
  useHideKeys(
    (hideKeyIds.length || selectedShape) && !view3d
      ? () => {
          const key = selectedShape?.kind === "label" ? "labels" : "areas"
          setHiddenPref({
            ...hidden,
            tiles: [...new Set([...hidden.tiles, ...hideKeyIds])],
            ...(selectedShape
              ? { [key]: [...new Set([...hidden[key], selectedShape.id])] }
              : {}),
          })
          setSelectedId(null)
          setSelectedShapeId(null)
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
      if ((e.target as HTMLElement | null)?.isContentEditable) return
      const bare = !e.ctrlKey && !e.metaKey && !e.altKey
      // E: Edit on and off, for those who may change the plan.
      if (
        bare &&
        !e.shiftKey &&
        e.key.toLowerCase() === "e" &&
        canToggleEdit &&
        !view3d
      ) {
        e.preventDefault()
        onToggleEdit?.(!canEdit)
        return
      }
      // P: the Place picker - from View too, for those who may edit.
      if (
        bare &&
        !e.shiftKey &&
        e.key.toLowerCase() === "p" &&
        (canEdit || canToggleEdit) &&
        !view3d &&
        onPlaceKey
      ) {
        e.preventDefault()
        if (!canEdit) onToggleEdit?.(true)
        onPlaceKey()
        return
      }
      // The tool keys (V, R, Shift+R, T, G, W, C, S).
      if (bare && canEdit && !view3d && selectTool) {
        const t = toolForKey(e.key, e.shiftKey)
        if (t) {
          e.preventDefault()
          selectTool(t)
          return
        }
      }
      const drawingShape = !!canvasApi?.current?.drawingShape?.()
      if (drawingShape && e.key === "Enter") {
        e.preventDefault()
        canvasApi?.current?.finishPolygon?.()
        return
      }
      if (drawingShape && e.key === "Backspace") {
        e.preventDefault()
        canvasApi?.current?.popPoint?.()
        return
      }
      if (e.key === "Escape" && !traceParam && !trayEditMode) {
        // A polygon half drawn goes first, then a drawing tool, and with
        // nothing left to put down Esc leaves Edit.
        if (drawingShape) {
          canvasApi?.current?.cancelDraw?.()
          return
        }
        if (canEdit && DRAW_TOOLS.includes(tool)) {
          selectTool?.("select")
          return
        }
        const busy =
          !!selectedId ||
          !!selectedShapeId ||
          !!ed.selectedWallId ||
          !!ed.selectedTrayId ||
          !!ed.selectedAreaId ||
          !!ed.selectedDoor ||
          multiSel.size > 0 ||
          drawPoints !== null ||
          !!armed
        if (canEdit && !busy && onToggleEdit) {
          onToggleEdit(false)
          return
        }
      }
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
        setSelectedShapeId(null)
        // A door goes first, then its wall.
        if (ed.selectedDoor) {
          ed.setSelectedDoor(null)
          return
        }
        setSelectedTrayId(null)
        setSelectedWallId(null)
        ed.setSelectedAreaId(null)
        ed.setStructSel(new Set())
        ed.setAreaSel(new Set())
        setDoorArmed(false)
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
      const free = plan?.layout_mode === "free"
      // Walls, doors, trays and raised floors: Delete, arrows (half a cell;
      // a raised floor a cell; a door slides 100 mm), F flips a door, J
      // joins two runs picked together.
      if ((mode === "structure" || mode === "cable") && plan && bare) {
        const handled = structureKey(e, {
          ed,
          structure,
          plan,
        })
        if (handled) {
          e.preventDefault()
          return
        }
      }
      // An area or a label: Delete, arrows (a half cell on a grid plan, a
      // cell on a free one, a tenth with Alt), Ctrl/⌘+[ and ] to restack.
      if (selectedShape && mode === "layout" && plan && shapeEdits) {
        if ((e.ctrlKey || e.metaKey) && (e.key === "[" || e.key === "]")) {
          e.preventDefault()
          shapeEdits.restack(selectedShape.id, e.key === "]" ? 1 : -1)
          return
        }
        if (selectedShape.locked) return
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault()
          shapeEdits.deleteShape(selectedShape.id)
          return
        }
        if (e.key.startsWith("Arrow")) {
          e.preventDefault()
          const step = e.altKey ? 0.1 : free ? 1 : 0.5
          let dx =
            e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
          let dy =
            e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
          const b = shapeBounds(selectedShape, plan.cell_mm)
          dx = Math.max(-b.minX, Math.min(plan.grid_width - b.maxX, dx))
          dy = Math.max(-b.minY, Math.min(plan.grid_height - b.maxY, dy))
          if (dx || dy)
            shapeEdits.changeShape(
              selectedShape.id,
              moveShapePatch(selectedShape, dx, dy)
            )
        }
        return
      }
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
        // A free plan nudges a tenth of a cell with Alt.
        const step = free && e.altKey ? 0.1 : 1
        const dx =
          e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0
        const dy =
          e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0
        const r3 = (v: number) => Math.round(v * 1000) / 1000
        changeTileGuarded(selectedId, {
          x: r3(
            Math.max(0, Math.min(plan.grid_width - tile.width, tile.x + dx))
          ),
          y: r3(
            Math.max(0, Math.min(plan.grid_height - tile.height, tile.y + dy))
          ),
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
    canToggleEdit,
    onToggleEdit,
    selectTool,
    shapeEdits,
    selectedShape,
    selectedShapeId,
    tool,
    armed,
    canvasApi,
    onPlaceKey,
    ed,
    structure,
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

/** A structure key in Structure or Cables mode; true when it did
 * something. */
export function structureKey(
  e: KeyboardEvent,
  {
    ed,
    structure,
    plan,
  }: {
    ed: PlanEditState
    structure: StructureEdits
    plan: FloorPlan
  }
): boolean {
  const grid = { w: plan.grid_width, h: plan.grid_height }
  const key = e.key
  const arrow = key.startsWith("Arrow")
  const dx = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0
  const dy = key === "ArrowUp" ? -1 : key === "ArrowDown" ? 1 : 0
  const door = ed.selectedDoor
  if (door) {
    const w = ed.structure.find((r) => r.id === door.wallId)
    if (w?.part !== "wall" || !w.openings[door.index]) return false
    if (key === "Delete" || key === "Backspace") {
      structure.deleteDoor(door.wallId, door.index)
      return true
    }
    if (key.toLowerCase() === "f") {
      structure.flipDoor(door.wallId, door.index)
      return true
    }
    if (arrow) {
      const step = (100 / plan.cell_mm) * (dx || dy)
      structure.changeDoor(
        door.wallId,
        door.index,
        slideDoor(w.points, w.openings, door.index, step)
      )
      return true
    }
    return false
  }
  if (key.toLowerCase() === "j" && ed.structSel.size === 2) {
    const [a, b] = [...ed.structSel]
    structure.join(a, b)
    return true
  }
  const id =
    ed.mode === "structure"
      ? (ed.selectedWallId ?? ed.selectedAreaId)
      : ed.selectedTrayId
  const row = id ? ed.structure.find((r) => r.id === id) : undefined
  if (!row) return false
  if (key === "Delete" || key === "Backspace") {
    structure.deleteRow(row.id)
    return true
  }
  if (!arrow) return false
  if (row.part === "raised_floor") {
    const x = Math.max(0, Math.min(grid.w - row.width, row.x + dx))
    const y = Math.max(0, Math.min(grid.h - row.height, row.y + dy))
    if (x !== row.x || y !== row.y) structure.patchArea(row.id, { x, y })
    return true
  }
  const points = translatePoints(row.points, dx * 0.5, dy * 0.5, grid)
  if (row.part === "wall") structure.patchWall(row.id, { points })
  else structure.change(row.id, { points })
  return true
}
