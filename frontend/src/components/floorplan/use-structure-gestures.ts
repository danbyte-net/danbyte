import { useRef, useState } from "react"
import { toast } from "sonner"

import type { FloorPlan, FloorPlanWallOpening } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import type { Handle, Pt } from "./shapes"
import {
  doorFromDrag,
  dropRepeats,
  fitOpenings,
  joinRuns,
  lengthText,
  moveSegment,
  projectOnSegment,
  rectsOverlap,
  resizeDoor,
  slideDoor,
  snapRect,
  snapStructPoint,
  structureLists,
  translatePoints,
} from "./structure"
import type { RaisedRow, RunRow, StructShape } from "./structure"

/** Screen pixels a snap reaches - the same pull areas and labels have. */
const SNAP_PX = 8
/** A press that moved less than this many pixels is a click. */
const CLICK_PX = 4

type Rect = { x: number; y: number; width: number; height: number }

type Gesture =
  | { type: "run"; id: string; start: Pt; at: { x: number; y: number } }
  | { type: "vertex"; id: string; index: number }
  | { type: "segment"; id: string; seg: number; start: Pt }
  | { type: "rect"; id: string; start: Pt; orig: Rect }
  | { type: "rect-resize"; id: string; handle: Handle; orig: Rect }
  | { type: "door-draw"; wallId: string; seg: number; t0: number; t1: number }
  | { type: "door-end"; wallId: string; index: number; end: "from" | "to" }
  | {
      type: "door-slide"
      wallId: string
      index: number
      t0: number
      orig: FloorPlanWallOpening
    }

/** What the canvas shows while a structure gesture runs. */
export interface StructurePreview {
  /** Rows as dragged, over the draft's. */
  rows: ReadonlyMap<string, StructShape>
  /** The door being drawn: its wall, segment and span. */
  door: { wallId: string; seg: number; from: number; to: number } | null
  /** Lines the dragged point lined up on. */
  guides: { x?: number; y?: number } | null
  /** A measure beside the pointer (a door's width), in cell units. */
  readout: { at: Pt; text: string } | null
}

const NO_ROWS: ReadonlyMap<string, StructShape> = new Map()

/**
 * The canvas's pointer work on walls, doors, trays and raised floors: moving
 * a whole run, one of its points or one of its segments; drawing, resizing
 * and sliding a door along its wall; moving and resizing a raised floor.
 * Rows show as dragged until the pointer lifts, then go to the page's draft
 * as one edit (one undo step). A point snaps onto the half-cell lattice and
 * onto other runs' points and edges, lining up with their points (guides);
 * dropped on another run's end it joins that run. Alt turns the pull off.
 */
export function useStructureGestures({
  svgRef,
  toWorld,
  zoom,
  plan,
  structure,
  editable,
  onCommit,
  onAddDoor,
  onSelectDoor,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>
  toWorld: (
    svg: SVGSVGElement,
    clientX: number,
    clientY: number
  ) => { x: number; y: number }
  zoom: number
  plan: FloorPlan
  structure: readonly StructShape[]
  editable: boolean
  /** Rows changed (and one removed, after a join) - one edit. */
  onCommit?: (c: { update: StructShape[]; remove?: string[] }) => void
  /** A door drawn along a wall, from `t0` to `t1` cells on segment `seg`. */
  onAddDoor?: (wallId: string, seg: number, t0: number, t1: number) => void
  onSelectDoor?: (door: { wallId: string; index: number } | null) => void
}) {
  const g = useRef<Gesture | null>(null)
  const [rows, setRows] = useState<ReadonlyMap<string, StructShape>>(NO_ROWS)
  const [door, setDoor] = useState<StructurePreview["door"]>(null)
  const [guides, setGuides] = useState<StructurePreview["guides"]>(null)
  const [readout, setReadout] = useState<StructurePreview["readout"]>(null)
  const grid = { w: plan.grid_width, h: plan.grid_height }
  const reach = SNAP_PX / (CELL * zoom)

  const cellAt = (e: { clientX: number; clientY: number }): Pt => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    return [w.x / CELL, w.y / CELL]
  }
  const rowOf = (id: string) =>
    rows.get(id) ?? structure.find((r) => r.id === id)
  const runOf = (id: string) => {
    const r = rowOf(id)
    return r && r.part !== "raised_floor" ? r : null
  }
  /** The runs a point of `part` snaps to: walls to walls, trays to trays. */
  const runsLike = (part: RunRow["part"]) => {
    const { walls, trays } = structureLists(structure)
    return part === "wall" ? walls : trays
  }
  const capture = (e: React.PointerEvent) => {
    e.stopPropagation()
    svgRef.current?.setPointerCapture(e.pointerId)
  }
  const preview = (row: StructShape) =>
    setRows((prev) => new Map(prev).set(row.id, row))
  const clear = () => {
    g.current = null
    setRows(NO_ROWS)
    setDoor(null)
    setGuides(null)
    setReadout(null)
  }
  /** The door's width beside the pointer. */
  const measure = (at: Pt, from: number, to: number) =>
    setReadout({ at, text: lengthText(to - from, plan.cell_mm) })

  // ── Presses ─────────────────────────────────────────────────────────────
  /** A press on a run's body: drag it whole. */
  const runDown = (row: RunRow, e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return false
    capture(e)
    g.current = {
      type: "run",
      id: row.id,
      start: cellAt(e),
      at: { x: e.clientX, y: e.clientY },
    }
    return true
  }
  const vertexDown = (row: RunRow, index: number, e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return
    capture(e)
    g.current = { type: "vertex", id: row.id, index }
  }
  const segmentDown = (row: RunRow, seg: number, e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return
    capture(e)
    g.current = { type: "segment", id: row.id, seg, start: cellAt(e) }
  }
  const rectDown = (row: RaisedRow, e: React.PointerEvent) => {
    if (!editable || e.button !== 0) return false
    capture(e)
    g.current = {
      type: "rect",
      id: row.id,
      start: cellAt(e),
      orig: { x: row.x, y: row.y, width: row.width, height: row.height },
    }
    return true
  }
  const rectHandleDown = (
    row: RaisedRow,
    handle: Handle,
    e: React.PointerEvent
  ) => {
    if (!editable || e.button !== 0) return
    capture(e)
    g.current = {
      type: "rect-resize",
      id: row.id,
      handle,
      orig: { x: row.x, y: row.y, width: row.width, height: row.height },
    }
  }
  /** The Door tool pressed on a wall: a door drawn along it from here. */
  const doorDrawDown = (row: RunRow, seg: number, e: React.PointerEvent) => {
    if (!editable || e.button !== 0 || row.part !== "wall") return
    capture(e)
    const { t } = projectOnSegment(row.points, seg, cellAt(e))
    g.current = { type: "door-draw", wallId: row.id, seg, t0: t, t1: t }
    setDoor({ wallId: row.id, seg, from: t, to: t })
  }
  const doorEndDown = (
    wallId: string,
    index: number,
    end: "from" | "to",
    e: React.PointerEvent
  ) => {
    if (!editable || e.button !== 0) return
    capture(e)
    g.current = { type: "door-end", wallId, index, end }
  }
  const doorSlideDown = (
    wallId: string,
    index: number,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0) return
    const w = runOf(wallId)
    if (!w || w.part !== "wall") return
    onSelectDoor?.({ wallId, index })
    if (!editable) return
    capture(e)
    const o = w.openings[index]
    g.current = {
      type: "door-slide",
      wallId,
      index,
      t0: projectOnSegment(w.points, o.seg, cellAt(e)).t,
      orig: o,
    }
  }

  // ── The drag ────────────────────────────────────────────────────────────
  const move = (e: React.PointerEvent): boolean => {
    const d = g.current
    if (!d) return false
    const p = cellAt(e)
    const free = e.altKey
    if (d.type === "run") {
      const row = structure.find((r) => r.id === d.id)
      if (!row || row.part === "raised_floor") return true
      if (
        !rows.has(d.id) &&
        Math.hypot(e.clientX - d.at.x, e.clientY - d.at.y) < CLICK_PX
      )
        return true
      // The run moves by lattice steps, its first point pulled onto
      // another run's point or edge.
      const raw: Pt = [
        row.points[0][0] + p[0] - d.start[0],
        row.points[0][1] + p[1] - d.start[1],
      ]
      const snap = snapStructPoint(raw, runsLike(row.part), {
        grid,
        reach,
        free,
        skip: row.id,
      })
      preview({
        ...row,
        points: translatePoints(
          row.points,
          snap.p[0] - row.points[0][0],
          snap.p[1] - row.points[0][1],
          grid
        ),
      })
      setGuides(snap.guides)
      return true
    }
    if (d.type === "vertex") {
      const row = structure.find((r) => r.id === d.id)
      if (!row || row.part === "raised_floor") return true
      const snap = snapStructPoint(p, runsLike(row.part), {
        grid,
        reach,
        free,
        skip: row.id,
      })
      const points = row.points.map((q, i): Pt =>
        i === d.index ? snap.p : [q[0], q[1]]
      )
      preview(
        row.part === "wall"
          ? { ...row, points, openings: fitOpenings(points, row.openings) }
          : { ...row, points }
      )
      setGuides(snap.guides)
      return true
    }
    if (d.type === "segment") {
      const row = structure.find((r) => r.id === d.id)
      if (!row || row.part === "raised_floor") return true
      const a = row.points[d.seg]
      const snap = snapStructPoint(
        [a[0] + p[0] - d.start[0], a[1] + p[1] - d.start[1]],
        runsLike(row.part),
        { grid, reach, free, skip: row.id }
      )
      const points = moveSegment(
        row.points,
        d.seg,
        snap.p[0] - a[0],
        snap.p[1] - a[1],
        grid
      )
      preview(
        row.part === "wall"
          ? { ...row, points, openings: fitOpenings(points, row.openings) }
          : { ...row, points }
      )
      setGuides(snap.guides)
      return true
    }
    if (d.type === "rect" || d.type === "rect-resize") {
      const row = structure.find((r) => r.id === d.id)
      if (!row || row.part !== "raised_floor") return true
      const o = d.orig
      let next: Rect
      if (d.type === "rect")
        next = {
          ...o,
          x: o.x + p[0] - d.start[0],
          y: o.y + p[1] - d.start[1],
        }
      else {
        let { x, y } = o
        let x2 = o.x + o.width
        let y2 = o.y + o.height
        if (d.handle.includes("w")) x = Math.min(p[0], x2 - 1)
        if (d.handle.includes("e")) x2 = Math.max(p[0], x + 1)
        if (d.handle.includes("n")) y = Math.min(p[1], y2 - 1)
        if (d.handle.includes("s")) y2 = Math.max(p[1], y + 1)
        x = Math.round(x)
        y = Math.round(y)
        next = {
          x,
          y,
          width: Math.round(x2) - x,
          height: Math.round(y2) - y,
        }
      }
      const others = structureLists(structure).raised.filter(
        (r) => r.id !== row.id
      )
      const snapped =
        d.type === "rect"
          ? snapRect(next, others, grid, reach, free)
          : { rect: snapRect(next, [], grid, 0, true).rect, guides: {} }
      preview({ ...row, ...snapped.rect })
      setGuides(snapped.guides)
      return true
    }
    if (d.type === "door-draw") {
      const w = runOf(d.wallId)
      if (!w) return true
      d.t1 = projectOnSegment(w.points, d.seg, p).t
      const span =
        w.part === "wall"
          ? doorFromDrag(w.points, w.openings, d.seg, d.t0, d.t1, plan.cell_mm)
          : null
      const lo = Math.min(d.t0, d.t1)
      const hi = Math.max(d.t0, d.t1)
      setDoor({
        wallId: d.wallId,
        seg: d.seg,
        from: span?.from ?? lo,
        to: span?.to ?? hi,
      })
      measure(p, span?.from ?? lo, span?.to ?? hi)
      return true
    }
    if (d.type === "door-end" || d.type === "door-slide") {
      const w = runOf(d.wallId)
      if (!w || w.part !== "wall") return true
      const base = structure.find((r) => r.id === d.wallId)
      if (!base || base.part !== "wall") return true
      const o = base.openings[d.index]
      if (!o) return true
      const t = projectOnSegment(base.points, o.seg, p).t
      const next =
        d.type === "door-end"
          ? resizeDoor(
              base.points,
              base.openings,
              d.index,
              d.end,
              t,
              plan.cell_mm
            )
          : slideDoor(base.points, base.openings, d.index, t - d.t0)
      preview({
        ...base,
        openings: base.openings.map((x, i) => (i === d.index ? next : x)),
      })
      measure(p, next.from, next.to)
      return true
    }
    return true
  }

  // ── The drop ────────────────────────────────────────────────────────────
  const up = (e?: React.PointerEvent): boolean => {
    const d = g.current
    if (!d) return false
    const dragged = rows.get("id" in d ? d.id : d.wallId)
    if (d.type === "door-draw") {
      const t1 = e
        ? (() => {
            const w = runOf(d.wallId)
            return w ? projectOnSegment(w.points, d.seg, cellAt(e)).t : d.t1
          })()
        : d.t1
      clear()
      onAddDoor?.(d.wallId, d.seg, d.t0, t1)
      return true
    }
    clear()
    if (!dragged) return true
    if (dragged.part === "raised_floor") {
      const clash = structureLists(structure).raised.some(
        (r) => r.id !== dragged.id && rectsOverlap(r, dragged)
      )
      if (clash) {
        toast.error("Raised floors must not overlap.")
        return true
      }
      onCommit?.({ update: [dragged] })
      return true
    }
    // A run end dropped on another run's end: the two become one.
    if (d.type === "vertex" && e && !e.altKey) {
      const last = dragged.points.length - 1
      if (d.index === 0 || d.index === last) {
        const end = dragged.points[d.index]
        const other = runsLike(dragged.part).find(
          (r) =>
            r.id !== dragged.id &&
            [r.points[0], r.points[r.points.length - 1]].some(
              (q) => Math.hypot(q[0] - end[0], q[1] - end[1]) < 1e-6
            )
        )
        if (other) {
          const joined = joinRuns(
            {
              points: dragged.points,
              openings: dragged.part === "wall" ? dragged.openings : [],
            },
            {
              points: other.points,
              openings: other.part === "wall" ? other.openings : [],
            }
          )
          if (joined) {
            const merged = { ...dragged, points: joined.points }
            if (merged.part === "wall") merged.openings = joined.openings
            if (merged.part === "tray" && other.part === "tray") {
              const ids = new Set(merged.cables.map((c) => c.id))
              merged.cables = [
                ...merged.cables,
                ...other.cables.filter((c) => !ids.has(c.id)),
              ]
            }
            onCommit?.({ update: [merged], remove: [other.id] })
            return true
          }
        }
      }
    }
    // A point dropped on its neighbour goes (a run keeps two).
    const kept = dropRepeats(
      dragged.points,
      dragged.part === "wall" ? dragged.openings : []
    )
    if (kept.points.length < 2) return true
    const changed = (
      kept.points.length === dragged.points.length
        ? dragged
        : {
            ...dragged,
            points: kept.points,
            ...(dragged.part === "wall" ? { openings: kept.openings } : {}),
          }
    ) as StructShape
    onCommit?.({ update: [changed] })
    return true
  }

  const cancel = () => clear()

  return {
    runDown,
    vertexDown,
    segmentDown,
    rectDown,
    rectHandleDown,
    doorDrawDown,
    doorEndDown,
    doorSlideDown,
    move,
    up,
    cancel,
    preview: { rows, door, guides, readout },
    /** A gesture of this hook holds the pointer. */
    active: () => !!g.current,
  }
}

export type StructureGestures = ReturnType<typeof useStructureGestures>
