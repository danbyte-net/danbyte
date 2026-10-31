import { useCallback } from "react"

import type { FloorPlan } from "@/lib/api"

import { labelPresetMm, polygonPatch } from "./shapes"
import type { AreaShape, LabelShape, PlanShape, Pt } from "./shapes"
import type { PlanEditState } from "./use-plan-edit-state"
import { isTemp, tempId } from "./use-tile-edits"

/** A new rectangle or polygon, in cell units. */
export type NewAreaGeometry =
  | { shape: "rect"; x: number; y: number; width: number; height: number }
  | { shape: "polygon"; points: Pt[] }

/** The text a new label starts with, selected in the inspector so typing
 * replaces it. */
export const NEW_LABEL_TEXT = "Text"

/** Every area and label edit - on the local draft, saved with the tiles in
 * one bulk transaction, each one an undo step. */
export function useShapeEdits({
  plan,
  ed,
}: {
  plan: FloorPlan | undefined
  ed: PlanEditState
}) {
  const {
    shapes,
    setShapes,
    setDirtyIds,
    setDeletedIds,
    setSelectedShapeId,
    setSelectedId,
    setMultiSel,
    setTool,
  } = ed

  const select = useCallback((id: string | null) => {
    setSelectedShapeId(id)
    if (id) {
      setSelectedId(null)
      setMultiSel((prev) => (prev.size ? new Set() : prev))
    }
  }, [])

  const add = useCallback((shape: PlanShape) => {
    setShapes((prev) => [...prev, shape])
    setDirtyIds((prev) => new Set(prev).add(shape.id))
    select(shape.id)
    // One drawing, then back to Select - the inspector links it.
    setTool("select")
  }, [])

  const topZ = (kind: PlanShape["kind"]) =>
    Math.max(-1, ...shapes.filter((s) => s.kind === kind).map((s) => s.z)) + 1

  const createArea = useCallback(
    (geom: NewAreaGeometry) => {
      const now = new Date().toISOString()
      const base: AreaShape = {
        kind: "area",
        id: tempId(),
        shape: geom.shape,
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        rotation: 0,
        points: [],
        room: null,
        location: null,
        area_type: null,
        label: "",
        color: "",
        fill_opacity: 15,
        border: "solid",
        show_name: true,
        z: topZ("area"),
        locked: false,
        created_at: now,
        updated_at: now,
      }
      add(
        geom.shape === "rect"
          ? {
              ...base,
              x: geom.x,
              y: geom.y,
              width: geom.width,
              height: geom.height,
            }
          : { ...base, ...polygonPatch(geom.points) }
      )
    },
    [shapes, add]
  )

  const createLabel = useCallback(
    (at: { x: number; y: number }) => {
      if (!plan) return
      const now = new Date().toISOString()
      const label: LabelShape = {
        kind: "label",
        id: tempId(),
        text: NEW_LABEL_TEXT,
        x: at.x,
        y: at.y,
        width: null,
        height: null,
        rotation: 0,
        font_mm: labelPresetMm("M", plan.cell_mm),
        weight: "normal",
        align: "left",
        color: "",
        plate: false,
        z: topZ("label"),
        locked: false,
        created_at: now,
        updated_at: now,
      }
      add(label)
    },
    [plan, shapes, add]
  )

  const changeShape = useCallback(
    (shapeId: string, patch: Partial<PlanShape>) => {
      setShapes((prev) =>
        prev.map((s) =>
          s.id === shapeId ? ({ ...s, ...patch } as PlanShape) : s
        )
      )
      setDirtyIds((prev) =>
        prev.has(shapeId) ? prev : new Set(prev).add(shapeId)
      )
    },
    []
  )

  const deleteShape = useCallback(
    (shapeId: string) => {
      setShapes((prev) => prev.filter((s) => s.id !== shapeId))
      setDirtyIds((prev) => {
        if (!prev.has(shapeId)) return prev
        const next = new Set(prev)
        next.delete(shapeId)
        return next
      })
      // The save sends it to the list of its kind.
      const kind = shapes.find((s) => s.id === shapeId)?.kind
      if (kind && !isTemp(shapeId))
        setDeletedIds((prev) => new Set(prev).add(`${kind}:${shapeId}`))
      setSelectedShapeId((cur) => (cur === shapeId ? null : cur))
    },
    [shapes]
  )

  /** Bring forward (+1) or send back (-1) among the shapes of its kind. */
  const restack = useCallback(
    (shapeId: string, dir: 1 | -1) => {
      const s = shapes.find((x) => x.id === shapeId)
      if (!s) return
      const zs = shapes.filter((x) => x.kind === s.kind).map((x) => x.z)
      const z = dir > 0 ? Math.max(...zs) + 1 : Math.min(...zs) - 1
      if (z !== s.z) changeShape(shapeId, { z })
    },
    [shapes, changeShape]
  )

  return {
    select,
    createArea,
    createLabel,
    changeShape,
    deleteShape,
    restack,
  }
}

export type ShapeEdits = ReturnType<typeof useShapeEdits>
