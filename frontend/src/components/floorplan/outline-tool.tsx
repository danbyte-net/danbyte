import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api, ApiError, apiErrorMessage } from "@/lib/api"
import type { FloorPlan } from "@/lib/api"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"

import { CELL } from "./canvas-geometry"
import { loadPicture, OutlineDetector } from "./outline-client"
import {
  cellsToPixels,
  clampToGrid,
  pixelsToCells,
  polygonArea,
  pxPerCell,
  shapeOutline,
} from "./outline-detect"
import type {
  DetectFailure,
  DetectOptions,
  Frame,
  Raster,
} from "./outline-detect"
import { polygonCrossesItself } from "./shapes"
import type { Pt } from "./shapes"
import { isLiveView, viewBackgroundFrame } from "./snapshot"
import type { CadDrawingState } from "./use-cad-drawing"
import type { PlanEditState } from "./use-plan-edit-state"
import type { ShapeEdits } from "./use-shape-edits"
import type { StructureEdits } from "./use-structure-edits"

// Detect outline (the tool rail's O, and "Detect outline here" on the
// plan's menu): a click on a building or a room proposes the polygon round
// it, shown over the plan with its corners to drag; Accept makes it an area
// (one undo step each), Accept + walls walls it too. Three ways to find it:
//
//   colour   - the background picture's colour round the click (a map);
//   room     - the white space round the click in a line drawing, its
//              doors bridged;
//   cad      - the smallest closed shape of the CAD drawing round the click,
//              from the server (exact corners).
//
// The picture work runs in a worker (outline-client.ts); the contour comes
// back in pixels and is simplified, squared and turned into cells here, so
// the sliders reshape it at once.

export type OutlineMode = "colour" | "room" | "cad"

export const OUTLINE_DEFAULTS = {
  tolerance: 8,
  threshold: 128,
  /** Door gap bridged in Fill room, in metres. */
  gapM: 1,
  /** Simplify, in cells. */
  simplify: 0.25,
  square: true,
} as const

/** A simplification never finer than this many pixels: a picture's
 * anti-aliased edge is a pixel or two wide. */
const MIN_EPSILON_PX = 2

/** One click's find. */
interface Found {
  id: string
  /** Where it was clicked, in cells. */
  at: Pt
  mode: OutlineMode
  /** colour / room: the region's contour in picture pixels. */
  contour?: Pt[]
  /** The picture's size the contour is in. */
  size?: { width: number; height: number }
  /** cad: the shape's corners in cells. */
  exact?: Pt[]
  /** Corners moved by hand, in cells: they win until the settings change. */
  edited?: Pt[]
}

const FAILURE: Record<DetectFailure, string> = {
  wall: "That is a wall: click inside the room",
  large: "Runs over most of the picture: lower the tolerance",
  small: "Nothing there to outline",
  outside: "Outside the background",
}

let seq = 0
const nextId = () => `outline-${++seq}`

/** The editor's Detect outline state: what was found, the settings, and
 * Accept / Cancel. */
export function useOutlineDetect({
  plan,
  cad,
  ed,
  shapeEdits,
  structure,
}: {
  plan: FloorPlan | undefined
  cad: CadDrawingState
  ed: PlanEditState
  shapeEdits: ShapeEdits
  structure: StructureEdits
}) {
  const active = ed.tool === "outline"
  // The floor's own picture, else the base map (a Site map snapshot) - it
  // lies on the same frame.
  const picture =
    plan?.background_image ??
    ((plan?.map_visible && plan.base_map?.image) || null)
  const hasCad = !!plan && !isLiveView(plan) && cad.drawing?.status === "ready"
  const modes = useMemo<OutlineMode[]>(
    () => [
      ...(picture ? (["colour", "room"] as const) : []),
      ...(hasCad ? (["cad"] as const) : []),
    ],
    [picture, hasCad]
  )
  const [modeChoice, setMode] = useState<OutlineMode | null>(null)
  const mode: OutlineMode | null =
    modeChoice && modes.includes(modeChoice)
      ? modeChoice
      : modes.includes("cad")
        ? "cad"
        : modes.length
          ? modes[0]
          : null
  const [tolerance, setTolerance] = useState<number>(OUTLINE_DEFAULTS.tolerance)
  const [threshold, setThreshold] = useState<number>(OUTLINE_DEFAULTS.threshold)
  const [gapM, setGapM] = useState<number>(OUTLINE_DEFAULTS.gapM)
  const [simplify, setSimplify] = useState<number>(OUTLINE_DEFAULTS.simplify)
  const [square, setSquare] = useState<boolean>(OUTLINE_DEFAULTS.square)
  const [found, setFound] = useState<Found[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const frame: Frame | null = plan
    ? (viewBackgroundFrame(plan) ?? {
        x: 0,
        y: 0,
        width: plan.grid_width,
        height: plan.grid_height,
      })
    : null

  // The picture as pixels, read once per background.
  const raster = useRef<{ url: string; raster: Promise<Raster> } | null>(null)
  const detector = useRef<OutlineDetector | null>(null)
  useEffect(() => () => detector.current?.dispose(), [])
  const pictureRaster = useCallback((url: string) => {
    if (raster.current?.url !== url)
      raster.current = { url, raster: loadPicture(url) }
    return raster.current.raster
  }, [])

  const cellMm = plan?.cell_mm ?? 600
  const options = useCallback(
    (m: "colour" | "room", r: Raster): DetectOptions => ({
      mode: m,
      tolerance,
      threshold,
      gapPx: frame ? (gapM * 1000 * pxPerCell(r, frame)) / cellMm : 0,
    }),
    [tolerance, threshold, gapM, frame?.width, frame?.height, cellMm]
  )

  /** Find what is round `at` (cells) with the picture. */
  const findRaster = useCallback(
    async (m: "colour" | "room", at: Pt): Promise<Found | string> => {
      if (!picture || !frame) return "No background picture"
      let r: Raster
      try {
        r = await pictureRaster(picture)
      } catch {
        raster.current = null
        return "The background can't be read here"
      }
      detector.current ??= new OutlineDetector()
      const px = cellsToPixels(at, r, frame)
      const res = await detector.current.detect(
        picture,
        r,
        [Math.floor(px[0]), Math.floor(px[1])],
        options(m, r)
      )
      if (!res.ok) return FAILURE[res.reason]
      return {
        id: nextId(),
        at,
        mode: m,
        contour: res.contour,
        size: { width: r.width, height: r.height },
      }
    },
    [picture, frame?.x, frame?.y, frame?.width, frame?.height, options]
  )

  /** The drawing's smallest closed shape round `at`. */
  const findCad = useCallback(
    async (at: Pt): Promise<Found | string> => {
      if (!plan) return "No drawing"
      try {
        const res = await api<{ points: Pt[]; layer: string }>(
          `/api/floor-plans/${plan.id}/drawing/loops/?x=${at[0].toFixed(4)}&y=${at[1].toFixed(4)}`
        )
        return { id: nextId(), at, mode: "cad", exact: res.points }
      } catch (err) {
        if (err instanceof ApiError && err.status === 404)
          return "No closed shape here"
        return apiErrorMessage(err, "The drawing can't be read")
      }
    },
    [plan?.id]
  )

  const find = useCallback(
    (m: OutlineMode, at: Pt) => (m === "cad" ? findCad(at) : findRaster(m, at)),
    [findCad, findRaster]
  )

  /** A click with the tool: what is round it, instead of what was found -
   * or, with Shift, as well. */
  const pickAt = useCallback(
    async (at: Pt, add = false, as: OutlineMode | null = mode) => {
      if (!as) {
        setMessage("Needs a map, picture or drawing")
        return
      }
      setBusy(true)
      setMessage(null)
      try {
        const res = await find(as, at)
        if (typeof res === "string") {
          setMessage(res)
          if (!add) setFound([])
          return
        }
        setFound((prev) => (add ? [...prev, res] : [res]))
      } finally {
        setBusy(false)
      }
    },
    [mode, find]
  )

  /** The canvas's pick (world px). */
  const pick = useCallback(
    (pt: { x: number; y: number }, mods?: { shiftKey?: boolean }) =>
      void pickAt([pt.x / CELL, pt.y / CELL], !!mods?.shiftKey),
    [pickAt]
  )

  // A setting changed: find the picture's outlines again from their clicks
  // (moved corners go - they belonged to the old outline).
  const rerun = useRef(0)
  useEffect(() => {
    const again = found.filter((f) => f.mode !== "cad")
    if (!again.length) return
    const n = ++rerun.current
    const t = setTimeout(() => {
      void Promise.all(
        again.map((f) => findRaster(f.mode as "colour" | "room", f.at))
      ).then((res) => {
        if (n !== rerun.current) return
        setFound((prev) =>
          prev.map((f) => {
            const i = again.findIndex((r) => r.id === f.id)
            const r = i >= 0 ? res[i] : null
            return r && typeof r !== "string" ? { ...r, id: f.id } : f
          })
        )
      })
    }, 150)
    return () => clearTimeout(t)
    // Only the detection settings re-run it.
  }, [tolerance, threshold, gapM])

  // Moved corners go with a new simplify or square setting.
  useEffect(() => {
    setFound((prev) =>
      prev.some((f) => f.edited)
        ? prev.map((f) => (f.edited ? { ...f, edited: undefined } : f))
        : prev
    )
  }, [simplify, square])

  // Putting the tool down drops what was found.
  useEffect(() => {
    if (!active) {
      setFound([])
      setMessage(null)
    }
  }, [active])

  const grid = plan
    ? { w: plan.grid_width, h: plan.grid_height }
    : { w: 0, h: 0 }

  /** Each find as an area outline in cells. */
  const outlines = useMemo(() => {
    return found.map((f) => {
      if (f.edited) return { id: f.id, points: f.edited, exact: !f.contour }
      if (f.exact)
        return {
          id: f.id,
          points: clampToGrid(f.exact, grid.w, grid.h),
          exact: true,
        }
      if (!f.contour || !f.size || !frame)
        return { id: f.id, points: [], exact: false }
      const size = f.size
      const eps = Math.max(MIN_EPSILON_PX, simplify * pxPerCell(size, frame))
      const pts = shapeOutline(f.contour, { epsilon: eps, square })
      return {
        id: f.id,
        points: clampToGrid(pixelsToCells(pts, size, frame), grid.w, grid.h),
        exact: false,
      }
    })
  }, [found, simplify, square, grid.w, grid.h, frame?.x, frame?.y])

  const moveCorner = useCallback(
    (id: string, index: number, to: Pt) => {
      const cur = outlines.find((o) => o.id === id)
      if (!cur) return
      const pts = cur.points.map((p, i) => (i === index ? to : p))
      setFound((prev) =>
        prev.map((f) =>
          f.id === id ? { ...f, edited: clampToGrid(pts, grid.w, grid.h) } : f
        )
      )
    },
    [outlines, grid.w, grid.h]
  )

  const cancel = useCallback(() => {
    setFound([])
    setMessage(null)
  }, [])

  /** Each outline an area - one undo step each - and, with `walls`, walls
   * round it in the same step, linked to it. The inspector opens on the
   * last. */
  const accept = useCallback(
    (walls: boolean) => {
      const good = outlines.filter(
        (o) => o.points.length >= 3 && !polygonCrossesItself(o.points)
      )
      if (!good.length) {
        setMessage("Nothing to add")
        return
      }
      good.forEach((o, i) => {
        ed.draft.beginGesture()
        const area = shapeEdits.createArea({
          shape: "polygon",
          points: o.points,
        })
        if (walls)
          structure.wallsAroundAreas([area.id], {
            extra: [area],
            appendLink: i > 0,
          })
        ed.draft.endGesture()
      })
      if (good.length < outlines.length)
        toast.info(
          `${outlines.length - good.length} outline${outlines.length - good.length === 1 ? "" : "s"} skipped: not a closed shape`
        )
      setFound([])
      setMessage(null)
    },
    [outlines, ed.draft, shapeEdits, structure]
  )

  return {
    active,
    modes,
    mode,
    setMode,
    tolerance,
    setTolerance,
    threshold,
    setThreshold,
    gapM,
    setGapM,
    simplify,
    setSimplify,
    square,
    setSquare,
    found,
    outlines,
    busy,
    message,
    pick,
    pickAt,
    moveCorner,
    accept,
    cancel,
    cellMm,
  }
}

export type OutlineDetect = ReturnType<typeof useOutlineDetect>

/** The outlines over the plan (world px): dashed, lightly filled, a handle
 * on each corner to drag. */
export function OutlinePreview({ od }: { od: OutlineDetect }) {
  const drag = useRef<{ id: string; index: number } | null>(null)
  if (!od.active || !od.outlines.length) return null
  const toCell = (e: React.PointerEvent<SVGElement>): Pt | null => {
    const g = e.currentTarget.parentNode as SVGGraphicsElement | null
    // jsdom has no layout: nothing to drag there.
    const m = typeof g?.getScreenCTM === "function" ? g.getScreenCTM() : null
    if (!m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return [p.x / CELL, p.y / CELL]
  }
  return (
    <g data-part="outline-preview">
      {od.outlines.map((o) =>
        o.points.length < 3 ? null : (
          <g key={o.id} data-outline={o.id}>
            <polygon
              points={o.points
                .map(([x, y]) => `${x * CELL},${y * CELL}`)
                .join(" ")}
              fill="var(--map-accent)"
              fillOpacity={0.12}
              stroke="var(--map-accent)"
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
            {o.points.map(([x, y], i) => (
              <circle
                key={i}
                data-outline-handle=""
                cx={x * CELL}
                cy={y * CELL}
                r={5}
                fill="var(--background)"
                stroke="var(--map-accent)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: "move" }}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  drag.current = { id: o.id, index: i }
                }}
                onPointerMove={(e) => {
                  const d = drag.current
                  if (!d || d.id !== o.id || d.index !== i) return
                  e.stopPropagation()
                  const p = toCell(e)
                  if (p) od.moveCorner(o.id, i, p)
                }}
                onPointerUp={(e) => {
                  if (!drag.current) return
                  e.stopPropagation()
                  drag.current = null
                }}
              />
            ))}
          </g>
        )
      )}
    </g>
  )
}

const MODE_LABEL: Record<OutlineMode, string> = {
  colour: "Colour",
  room: "Fill room",
  cad: "CAD shape",
}

/** One labelled slider with its value. */
function SliderRow({
  label,
  value,
  shown,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  shown: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex w-44 flex-col gap-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="whitespace-nowrap text-muted-foreground">{label}</span>
        <span className="num">{shown}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={(v) => onChange(v[0])}
        thumbProps={{ "aria-label": label }}
      />
    </div>
  )
}

/** The tool's card over the plan: the way to find, its settings, and what
 * was found with Accept, Accept + walls and Cancel. Enter accepts, Esc
 * cancels. */
export function OutlinePanel({ od }: { od: OutlineDetect }) {
  const { accept, cancel } = od
  const has = od.outlines.length > 0
  // Enter and Esc reach the card before the editor's keys.
  useEffect(() => {
    if (!od.active || !has) return
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return
      if (e.key === "Enter") {
        e.preventDefault()
        e.stopImmediatePropagation()
        accept(false)
      } else if (e.key === "Escape") {
        e.preventDefault()
        e.stopImmediatePropagation()
        cancel()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [od.active, has, accept, cancel])
  if (!od.active) return null
  const raster = od.found.some((f) => f.mode !== "cad")
  const corners = od.outlines.reduce((n, o) => n + o.points.length, 0)
  const m2 =
    od.outlines.reduce((s, o) => s + polygonArea(o.points), 0) *
    (od.cellMm / 1000) ** 2
  return (
    <div
      data-part="outline-panel"
      className="pointer-events-auto absolute top-3 left-1/2 z-20 flex max-w-[calc(100%-2rem)] -translate-x-1/2 flex-col gap-2 rounded-lg border border-border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md"
    >
      <div className="flex flex-wrap items-end gap-3">
        {od.modes.length > 1 && od.mode && (
          <SegmentedTabs<OutlineMode>
            value={od.mode}
            onValueChange={(m) => {
              od.setMode(m)
              cancel()
            }}
            items={od.modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
          />
        )}
        {od.mode === "colour" && (
          <SliderRow
            label="Tolerance"
            value={od.tolerance}
            shown={`${od.tolerance}`}
            min={1}
            max={40}
            step={1}
            onChange={od.setTolerance}
          />
        )}
        {od.mode === "room" && (
          <>
            <SliderRow
              label="Threshold"
              value={od.threshold}
              shown={`${od.threshold}`}
              min={16}
              max={240}
              step={1}
              onChange={od.setThreshold}
            />
            <SliderRow
              label="Door gap"
              value={od.gapM}
              shown={`${od.gapM.toFixed(1)} m`}
              min={0}
              max={3}
              step={0.1}
              onChange={od.setGapM}
            />
          </>
        )}
      </div>
      {has ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="num whitespace-nowrap" data-part="outline-stats">
            {od.outlines.length > 1 ? `${od.outlines.length} outlines · ` : ""}
            {corners} corners · {m2.toFixed(m2 < 100 ? 1 : 0)} m²
          </span>
          {raster && (
            <>
              <div className="flex items-center gap-1.5">
                <Switch
                  id="outline-square"
                  size="sm"
                  checked={od.square}
                  onCheckedChange={od.setSquare}
                />
                <Label
                  htmlFor="outline-square"
                  className="text-sm whitespace-nowrap"
                >
                  Square corners
                </Label>
              </div>
              <SliderRow
                label="Simplify"
                value={od.simplify}
                shown={`${od.simplify.toFixed(2)} cell`}
                min={0}
                max={2}
                step={0.05}
                onChange={od.setSimplify}
              />
            </>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <Button size="sm" onClick={() => accept(false)}>
              Accept
            </Button>
            <Button size="sm" variant="outline" onClick={() => accept(true)}>
              Accept + walls
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Cancel"
              onClick={cancel}
            >
              <X />
            </Button>
          </div>
        </div>
      ) : (
        <span
          className="text-xs whitespace-nowrap text-muted-foreground"
          data-part="outline-hint"
        >
          {od.busy
            ? "Finding…"
            : (od.message ??
              (od.modes.length
                ? "Click a building or room · Shift adds more"
                : "Needs a map, picture or drawing"))}
        </span>
      )}
      {!has && od.modes.length > 0 && !od.message && !od.busy && (
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          Works best on maps, CAD and line drawings
        </span>
      )}
    </div>
  )
}
