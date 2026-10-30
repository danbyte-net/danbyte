import { useRef, useState } from "react"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"

import { CELL } from "./canvas-geometry"
import {
  boxBounds,
  moveShapePatch,
  polygonCrossesItself,
  polygonPatch,
  resizeBox,
  rotateAngle,
  shapeBounds,
  shapeBox,
  snapBounds,
  snapLinesOf,
  snapPoint,
  tileAnglePatch,
  tileBox,
  tileQuarter,
} from "./shapes"
import type { Bounds, Box, Handle, PlanShape, Pt, SnapLines } from "./shapes"
import type { NewAreaGeometry } from "./use-shape-edits"

/** What a handle or a drag works on: an area or label, or a tile on a free
 * plan. */
export type GestureTarget =
  { kind: "shape"; id: string } | { kind: "tile"; id: string }

/** The drawing tools the canvas answers. */
export type ShapeTool = "rect" | "polygon" | "label"

type Gesture =
  | {
      type: "move"
      target: GestureTarget
      start: Pt
      bounds: Bounds
      /** What must stay on the plan. */
      keep: Bounds
      lines: SnapLines
      moved: boolean
    }
  | {
      type: "resize"
      target: GestureTarget
      handle: Handle
      box: Box
      lines: SnapLines
      /** A label's text height when the drag began. */
      font: number
    }
  | { type: "rotate"; target: GestureTarget; box: Box }
  | { type: "vertex"; id: string; index: number; lines: SnapLines }
  | { type: "draw-rect"; start: Pt; end: Pt; lines: SnapLines }
  | { type: "click"; shape: PlanShape; at: { x: number; y: number } }

/** Screen pixels a snap reaches. */
const SNAP_PX = 8
/** A click that moved less than this many pixels is a click. */
const CLICK_PX = 5
/** A rectangle drawn smaller than this (cells) is a click: a default area. */
const TINY = 0.25
const DEFAULT_AREA = 3

/**
 * The canvas's pointer work on areas, labels and free tiles: drawing a
 * rectangle, a polygon or a label; moving, resizing and turning what is
 * selected; dragging a polygon's points. Every edit goes through the
 * page's draft (one undo step per gesture). Snapping: a grid plan settles
 * shapes on half cells, a free plan pulls them onto grid lines; both pull
 * edges onto other shapes' edges and middles. Alt turns snapping off.
 */
export function useShapeGestures({
  svgRef,
  toWorld,
  zoom,
  plan,
  shapes,
  tiles,
  tool,
  editable,
  selectedShapeId,
  onSelectShape,
  onChangeShape,
  onCreateArea,
  onCreateLabel,
  onOpenShape,
  onChangeTile,
  onGestureStart,
  onGestureEnd,
  startPan,
}: {
  svgRef: React.RefObject<SVGSVGElement | null>
  toWorld: (
    svg: SVGSVGElement,
    clientX: number,
    clientY: number
  ) => { x: number; y: number }
  zoom: number
  plan: FloorPlan
  shapes: PlanShape[]
  tiles: FloorPlanTile[]
  tool: ShapeTool | null
  editable: boolean
  selectedShapeId: string | null
  onSelectShape?: (id: string | null) => void
  onChangeShape?: (id: string, patch: Partial<PlanShape>) => void
  onCreateArea?: (geom: NewAreaGeometry) => void
  onCreateLabel?: (at: { x: number; y: number }) => void
  onOpenShape?: (shape: PlanShape) => void
  onChangeTile?: (id: string, patch: Partial<FloorPlanTile>) => void
  onGestureStart?: () => void
  onGestureEnd?: () => void
  /** Hand the press to the canvas's pan. */
  startPan: (e: React.PointerEvent) => void
}) {
  const g = useRef<Gesture | null>(null)
  // The polygon being drawn, and where the pointer is.
  const [poly, setPoly] = useState<Pt[] | null>(null)
  const [cursor, setCursor] = useState<Pt | null>(null)
  const [rectDraft, setRectDraft] = useState<{ a: Pt; b: Pt } | null>(null)
  // The snap lines in use, drawn as guides while a drag holds one.
  const [guides, setGuides] = useState<{
    x: number | null
    y: number | null
  } | null>(null)

  const free = plan.layout_mode === "free"
  const gw = plan.grid_width
  const gh = plan.grid_height
  const cellMm = plan.cell_mm

  const at = (e: { clientX: number; clientY: number }): Pt => {
    const w = toWorld(svgRef.current!, e.clientX, e.clientY)
    return [w.x / CELL, w.y / CELL]
  }
  const clampPt = (p: Pt): Pt => [
    Math.max(0, Math.min(gw, p[0])),
    Math.max(0, Math.min(gh, p[1])),
  ]
  const snapOpts = (forShape: boolean) => ({
    step: 1,
    threshold: SNAP_PX / (CELL * zoom),
    // A grid plan keeps areas and labels on its half cells.
    hardStep: !free && forShape ? 0.5 : undefined,
  })
  /** The lines everything but `skip` offers. */
  const linesExcept = (skip: GestureTarget | null): SnapLines => {
    const bounds: Bounds[] = []
    for (const s of shapes)
      if (!(skip?.kind === "shape" && skip.id === s.id))
        bounds.push(shapeBounds(s, cellMm))
    for (const t of tiles)
      if (!(skip?.kind === "tile" && skip.id === t.id) && !t.tile_type?.is_zone)
        bounds.push(boxBounds(tileBox(t)))
    return snapLinesOf(bounds)
  }
  const snapPt = (p: Pt, lines: SnapLines, alt: boolean, forShape = true) =>
    clampPt(alt ? p : snapPoint(p, lines, snapOpts(forShape)))

  const shapeById = (id: string) => shapes.find((s) => s.id === id)
  const tileById = (id: string) => tiles.find((t) => t.id === id)
  const boxOf = (target: GestureTarget): Box | null => {
    if (target.kind === "tile") {
      const t = tileById(target.id)
      return t ? tileBox(t) : null
    }
    const s = shapeById(target.id)
    return s ? shapeBox(s, cellMm) : null
  }
  const boundsOf = (target: GestureTarget): Bounds | null => {
    if (target.kind === "tile") {
      const t = tileById(target.id)
      return t ? boxBounds(tileBox(t)) : null
    }
    const s = shapeById(target.id)
    return s ? shapeBounds(s, cellMm) : null
  }
  /** Whether an upright box stays on the plan. */
  const fits = (b: { x: number; y: number; width: number; height: number }) =>
    b.x >= -1e-6 &&
    b.y >= -1e-6 &&
    b.x + b.width <= gw + 1e-6 &&
    b.y + b.height <= gh + 1e-6

  const capture = (e: React.PointerEvent) =>
    svgRef.current?.setPointerCapture(e.pointerId)

  // ── Drawing ─────────────────────────────────────────────────────────────

  /** A press on the plan with a drawing tool armed. True when taken. */
  const drawDown = (e: React.PointerEvent): boolean => {
    if (!tool || !editable || e.button !== 0) return false
    const lines = linesExcept(null)
    const p = snapPt(at(e), lines, e.altKey)
    if (tool === "label") {
      onCreateLabel?.({ x: p[0], y: p[1] })
      return true
    }
    if (tool === "rect") {
      capture(e)
      g.current = { type: "draw-rect", start: p, end: p, lines }
      setRectDraft({ a: p, b: p })
      return true
    }
    // Polygon: each click a point; a click on the first point closes it.
    const pts = poly ?? []
    const near =
      pts.length >= 3 &&
      Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]) <
        (SNAP_PX * 1.5) / (CELL * zoom)
    if (near) {
      finishPolygon()
      return true
    }
    const last = pts.at(-1)
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-6)
      setPoly([...pts, p])
    return true
  }

  /** Close the polygon being drawn (Enter, a double-click, or a click on its
   * first point). False when it has fewer than three points or crosses
   * itself - it stays open. */
  const finishPolygon = (): boolean => {
    const pts = (poly ?? []).filter(
      (p, i, all) =>
        i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-6
    )
    if (pts.length < 3 || polygonCrossesItself(pts)) return false
    setPoly(null)
    setCursor(null)
    onCreateArea?.({ shape: "polygon", points: pts })
    return true
  }
  const cancelDraw = () => {
    setPoly(null)
    setCursor(null)
    setRectDraft(null)
    if (g.current?.type === "draw-rect") g.current = null
  }
  /** Backspace while drawing a polygon: take back its last point. */
  const popPoint = () =>
    setPoly((pts) => (pts && pts.length > 1 ? pts.slice(0, -1) : null))

  // ── Selection, moving, handles ──────────────────────────────────────────

  /** A press on an area or a label. True when taken. */
  const shapeDown = (shape: PlanShape, e: React.PointerEvent): boolean => {
    if (e.button !== 0) return false
    // A drawing tool draws over whatever is there.
    if (tool && editable) return false
    // Shift- or Ctrl/⌘-drag sweeps tiles into the selection, over areas too.
    if (editable && (e.shiftKey || e.ctrlKey || e.metaKey)) return false
    e.stopPropagation()
    if (!editable) {
      // Viewing: a drag pans, a click opens what the area stands for.
      startPan(e)
      g.current = { type: "click", shape, at: { x: e.clientX, y: e.clientY } }
      return true
    }
    const selected = shape.id === selectedShapeId
    onSelectShape?.(shape.id)
    // An area must be selected before it moves: a big room under the
    // pointer would otherwise catch every attempt to pan the plan.
    if ((shape.kind === "area" && !selected) || shape.locked) {
      startPan(e)
      return true
    }
    startMove({ kind: "shape", id: shape.id }, e)
    return true
  }

  /** A press on a tile of a free plan: select it and drag it smoothly. */
  const tileDown = (tile: FloorPlanTile, e: React.PointerEvent) => {
    startMove({ kind: "tile", id: tile.id }, e)
  }

  const startMove = (target: GestureTarget, e: React.PointerEvent) => {
    const bounds = boundsOf(target)
    if (!bounds) return
    // It stays on the plan both as drawn and as stored (the upright box
    // the server checks): the union of the two is what is kept inside.
    const raw = boxOf(target)
    const keep = raw
      ? {
          minX: Math.min(bounds.minX, raw.x),
          minY: Math.min(bounds.minY, raw.y),
          maxX: Math.max(bounds.maxX, raw.x + raw.width),
          maxY: Math.max(bounds.maxY, raw.y + raw.height),
        }
      : bounds
    capture(e)
    onGestureStart?.()
    g.current = {
      type: "move",
      target,
      start: at(e),
      bounds,
      keep,
      lines: linesExcept(target),
      moved: false,
    }
  }

  const handleDown = (
    target: GestureTarget,
    handle: Handle,
    e: React.PointerEvent
  ) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    const box = boxOf(target)
    if (!box) return
    capture(e)
    onGestureStart?.()
    const s = target.kind === "shape" ? shapeById(target.id) : undefined
    g.current = {
      type: "resize",
      target,
      handle,
      box,
      lines: linesExcept(target),
      font: s?.kind === "label" ? s.font_mm : 0,
    }
  }

  const rotateDown = (target: GestureTarget, e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    const box = boxOf(target)
    if (!box) return
    capture(e)
    onGestureStart?.()
    g.current = { type: "rotate", target, box }
  }

  const vertexDown = (id: string, index: number, e: React.PointerEvent) => {
    if (e.button !== 0 || !editable) return
    e.stopPropagation()
    capture(e)
    onGestureStart?.()
    g.current = {
      type: "vertex",
      id,
      index,
      lines: linesExcept({ kind: "shape", id }),
    }
  }

  /** A double-click on a polygon's edge: a new point there. */
  const addVertex = (id: string, seg: number, e: React.MouseEvent) => {
    const s = shapeById(id)
    if (!editable || !s || s.kind !== "area" || s.shape !== "polygon") return
    e.stopPropagation()
    const p = clampPt(at(e))
    const points = [...s.points]
    points.splice(seg + 1, 0, p)
    onChangeShape?.(id, polygonPatch(points))
  }

  // ── Pointer move / up ───────────────────────────────────────────────────

  /** True when a gesture of this hook took the move. */
  const move = (e: React.PointerEvent): boolean => {
    const p = at(e)
    if (poly && tool === "polygon") {
      setCursor(snapPt(p, linesExcept(null), e.altKey))
    }
    const d = g.current
    if (!d || d.type === "click") return false
    if (d.type === "draw-rect") {
      d.end = snapPt(p, d.lines, e.altKey)
      setRectDraft({ a: d.start, b: d.end })
      return true
    }
    if (d.type === "move") {
      let dx = p[0] - d.start[0]
      let dy = p[1] - d.start[1]
      if (!d.moved && Math.hypot(dx, dy) * CELL * zoom < 2) return true
      d.moved = true
      const forShape = d.target.kind === "shape"
      if (!e.altKey) {
        const s = snapBounds(
          {
            minX: d.bounds.minX + dx,
            maxX: d.bounds.maxX + dx,
            minY: d.bounds.minY + dy,
            maxY: d.bounds.maxY + dy,
          },
          d.lines,
          snapOpts(forShape)
        )
        dx += s.dx
        dy += s.dy
        setGuides(s.gx !== null || s.gy !== null ? { x: s.gx, y: s.gy } : null)
      } else setGuides(null)
      // Keep it on the plan.
      dx = Math.max(-d.keep.minX, Math.min(gw - d.keep.maxX, dx))
      dy = Math.max(-d.keep.minY, Math.min(gh - d.keep.maxY, dy))
      if (d.target.kind === "tile") {
        const t = tileById(d.target.id)
        if (!t) return true
        // The bounds are the turned box's; the stored box moves by the same.
        const b0 = boxBounds(tileBox(t))
        const ox = d.bounds.minX - b0.minX
        const oy = d.bounds.minY - b0.minY
        const r3 = (v: number) => Math.round(v * 1000) / 1000
        onChangeTile?.(t.id, { x: r3(t.x + ox + dx), y: r3(t.y + oy + dy) })
        return true
      }
      const s = shapeById(d.target.id)
      if (!s) return true
      const b0 = shapeBounds(s, cellMm)
      onChangeShape?.(
        s.id,
        moveShapePatch(
          s,
          d.bounds.minX + dx - b0.minX,
          d.bounds.minY + dy - b0.minY
        )
      )
      return true
    }
    if (d.type === "resize") {
      const snapped =
        e.altKey || d.box.rotation
          ? p
          : snapPoint(p, d.lines, snapOpts(d.target.kind === "shape"))
      const shape =
        d.target.kind === "shape" ? shapeById(d.target.id) : undefined
      const label = shape?.kind === "label" ? shape : null
      const nb = resizeBox(d.box, d.handle, snapped, {
        keepAspect: e.shiftKey || !!label,
        min: label ? 0.05 : undefined,
      })
      if (!fits(nb)) return true
      if (d.target.kind === "tile") {
        onChangeTile?.(d.target.id, {
          x: nb.x,
          y: nb.y,
          width: nb.width,
          height: nb.height,
        })
        return true
      }
      if (label) {
        // A label's box follows its text: a handle scales the text.
        const k = nb.height / Math.max(1e-6, d.box.height)
        const font = Math.round(Math.max(20, Math.min(5000, d.font * k)))
        onChangeShape?.(label.id, { x: nb.x, y: nb.y, font_mm: font })
        return true
      }
      onChangeShape?.(d.target.id, {
        x: nb.x,
        y: nb.y,
        width: nb.width,
        height: nb.height,
      })
      return true
    }
    if (d.type === "rotate") {
      const angle = rotateAngle(d.box, p, {
        step: e.shiftKey ? 15 : undefined,
        magnet: e.altKey ? 0 : 4,
      })
      if (d.target.kind === "tile") {
        const t = tileById(d.target.id)
        if (!t) return true
        // The handle turns the box drawn: its quarter turn stays the frame.
        let rel = angle
        if (rel > 180) rel -= 360
        onChangeTile?.(
          t.id,
          tileAnglePatch(t, tileQuarter(t.orientation) + rel)
        )
        return true
      }
      onChangeShape?.(d.target.id, { rotation: angle })
      return true
    }
    // A polygon's point.
    const s = shapeById(d.id)
    if (!s || s.kind !== "area") return true
    const points = [...s.points]
    points[d.index] = snapPt(p, d.lines, e.altKey)
    onChangeShape?.(d.id, polygonPatch(points))
    return true
  }

  /** True when a gesture of this hook ended here. */
  const up = (e: React.PointerEvent): boolean => {
    const d = g.current
    g.current = null
    setGuides(null)
    if (!d) return false
    if (d.type === "click") {
      // The pan the press began ends in the canvas; a still press opens.
      if (Math.hypot(e.clientX - d.at.x, e.clientY - d.at.y) < CLICK_PX)
        onOpenShape?.(d.shape)
      return false
    }
    if (d.type === "draw-rect") {
      setRectDraft(null)
      const x = Math.min(d.start[0], d.end[0])
      const y = Math.min(d.start[1], d.end[1])
      const w = Math.abs(d.end[0] - d.start[0])
      const h = Math.abs(d.end[1] - d.start[1])
      if (w < TINY && h < TINY) {
        // A click: a default area there, inside the plan.
        const width = Math.min(DEFAULT_AREA, gw)
        const height = Math.min(DEFAULT_AREA, gh)
        onCreateArea?.({
          shape: "rect",
          x: Math.min(d.start[0], gw - width),
          y: Math.min(d.start[1], gh - height),
          width,
          height,
        })
      } else
        onCreateArea?.({
          shape: "rect",
          x,
          y,
          width: Math.max(TINY, w),
          height: Math.max(TINY, h),
        })
      return true
    }
    onGestureEnd?.()
    return true
  }

  /** A pinch took over: drop what the press began. */
  const cancel = () => {
    const d = g.current
    g.current = null
    setGuides(null)
    setRectDraft(null)
    if (d && d.type !== "draw-rect" && d.type !== "click") onGestureEnd?.()
  }

  return {
    drawDown,
    shapeDown,
    tileDown,
    handleDown,
    rotateDown,
    vertexDown,
    addVertex,
    move,
    up,
    cancel,
    finishPolygon,
    cancelDraw,
    popPoint,
    poly,
    cursor,
    rectDraft,
    guides,
    /** A gesture of this hook holds the pointer. */
    active: () => !!g.current && g.current.type !== "click",
  }
}

export type ShapeGestures = ReturnType<typeof useShapeGestures>
