import {
  createContext,
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react"
import type { KeyboardEvent, PointerEvent, ReactNode, RefObject } from "react"

import type { DinProfile } from "@/lib/api"
import { plateView } from "@/lib/cabinet-drawing"
import { PROFILE_LABELS, band, clampToPlate, fmtMm } from "@/lib/din-geometry"
import { cn } from "@/lib/utils"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

// A cabinet's mounting plate drawn to scale (#277): one SVG whose user units
// are millimetres from the plate's top-left corner, so anything placed on the
// plate - a rail's band here, the devices on the rails later - is a plain
// rectangle in the same numbers the API stores. Lines stay one pixel at any
// size (non-scaling strokes), and text is sized in pixels by measuring how
// large the drawing came out.

/** A rail as the elevation draws it. */
export interface ElevationRail {
  /** Stable key: the rail's id, or the editor's row key. */
  key: string
  label: string
  profile: DinProfile
  x_mm: number
  y_mm: number
  length_mm: number
  /** Drawn in the error colour: a rail the editor says will not save. */
  invalid?: boolean
  /** Drawn faint: a rail the device being placed does not mount on. */
  dimmed?: boolean
}

export interface CabinetElevationProps {
  /** The mounting plate, in mm. */
  width: number
  height: number
  /** The box, drawn centred around the plate when both sides are known. */
  outerWidth?: number | null
  outerHeight?: number | null
  rails: ElevationRail[]
  /** Written on a plate that carries no rails. */
  emptyText?: string
  /** The rail picked in the editor, drawn in the selection colour. */
  selected?: string | null
  onSelect?: (key: string | null) => void
  /** Makes the rails draggable, in whole millimetres, and nudgeable with the
   * arrow keys (1 mm, 10 with Shift). Called with the rail's new left end
   * and centreline, kept on the plate. */
  onMove?: (key: string, at: { x_mm: number; y_mm: number }) => void
  /** Write each rail's label at its left end. Off when the devices drawn
   * over the rails write the labels where the rails still show. */
  railLabels?: boolean
  /** Drawn over the rails, in plate millimetres - the devices on them.
   * `usePlatePx()` sizes text and gaps in screen pixels inside it. */
  children?: ReactNode
  /** Draw at this many screen pixels per millimetre, in a frame that
   * scrolls, instead of filling the column - the cabinet page's zoom. */
  pxPerMm?: number
  className?: string
}

// The frame is the exported drawing's too (lib/cabinet-drawing.ts).
export { plateView }

/** Screen pixels as plate millimetres, at the size the plate is drawn. */
const PlatePx = createContext<(n: number) => number>((n) => n)

/** For what is drawn over the plate: `px(10)` is ten screen pixels, in the
 * plate's millimetres, so text keeps its size however large the plate is. */
export function usePlatePx(): (n: number) => number {
  return useContext(PlatePx)
}

/** Screen pixels a press travels before it drags, so a click never nudges. */
const DRAG_SLOP_PX = 3
/** Until the drawing is measured, take it to be about this wide. */
const ASSUMED_WIDTH_PX = 480

const TONE = {
  plain: "fill-muted-foreground/20 stroke-muted-foreground/60",
  selected: "fill-primary/20 stroke-primary",
  invalid: "fill-destructive/15 stroke-destructive",
  dimmed: "fill-muted-foreground/[0.06] stroke-muted-foreground/25",
} as const

const NUDGE: Partial<Record<string, [number, number]>> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
}

interface Drag {
  key: string
  pointerId: number
  /** Where the press landed, on screen and on the plate. */
  client: { x: number; y: number }
  at: { x: number; y: number }
  /** The rail's left end and centreline when it was picked up. */
  from: { x: number; y: number }
  moved: boolean
}

export function CabinetElevation({
  width,
  height,
  outerWidth,
  outerHeight,
  rails,
  emptyText,
  selected,
  onSelect,
  onMove,
  railLabels = true,
  children,
  pxPerMm,
  className,
}: CabinetElevationProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)

  const view = plateView(width, height, outerWidth, outerHeight)
  const box = view.box
  const drawn = useDrawnScale(svgRef, view.w, view.h)
  const scale = pxPerMm ?? (drawn || ASSUMED_WIDTH_PX / view.w)
  /** Screen pixels as plate millimetres. */
  const px = (n: number) => n / scale
  const interactive = !!onMove

  const move = (r: ElevationRail, x: number, y: number) => {
    const next = clampToPlate(r, x, y, width, height)
    if (next.x_mm !== r.x_mm || next.y_mm !== r.y_mm) onMove?.(r.key, next)
  }

  const startDrag = (r: ElevationRail, e: PointerEvent<SVGGElement>) => {
    onSelect?.(r.key)
    if (!onMove || e.button !== 0) return
    const at = toPlateMm(svgRef.current, e)
    if (!at) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = {
      key: r.key,
      pointerId: e.pointerId,
      client: { x: e.clientX, y: e.clientY },
      at,
      from: { x: r.x_mm, y: r.y_mm },
      moved: false,
    }
  }

  const continueDrag = (r: ElevationRail, e: PointerEvent<SVGGElement>) => {
    const d = drag.current
    if (!d || d.key !== r.key || d.pointerId !== e.pointerId) return
    const travel = Math.hypot(e.clientX - d.client.x, e.clientY - d.client.y)
    if (!d.moved && travel < DRAG_SLOP_PX) return
    d.moved = true
    const at = toPlateMm(svgRef.current, e)
    if (!at) return
    // Snap where the rail lands to whole millimetres.
    move(
      r,
      Math.round(d.from.x + at.x - d.at.x),
      Math.round(d.from.y + at.y - d.at.y)
    )
  }

  const endDrag = (e: PointerEvent<SVGGElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null
  }

  const nudge = (r: ElevationRail, e: KeyboardEvent<SVGGElement>) => {
    const step = NUDGE[e.key]
    if (!onMove || !step) return
    e.preventDefault()
    const by = e.shiftKey ? 10 : 1
    move(r, r.x_mm + step[0] * by, r.y_mm + step[1] * by)
  }

  return (
    <svg
      ref={svgRef}
      viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
      className={cn(
        "block select-none",
        !pxPerMm && "h-auto max-h-[28rem] w-full",
        className
      )}
      style={
        pxPerMm
          ? { width: view.w * pxPerMm, height: view.h * pxPerMm }
          : undefined
      }
      // Devices drawn over the plate are links; an img would hide them.
      role={interactive || children ? "group" : "img"}
      aria-label={`Plate ${fmtMm(width)}×${fmtMm(height)} mm, ${rails.length} rail${rails.length === 1 ? "" : "s"}`}
    >
      {box && (
        <rect
          data-part="box"
          x={-(box.w - width) / 2}
          y={-(box.h - height) / 2}
          width={box.w}
          height={box.h}
          rx={px(6)}
          className="fill-muted/60 stroke-border"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <rect
        data-part="plate"
        x={0}
        y={0}
        width={width}
        height={height}
        rx={px(3)}
        className="fill-background stroke-border"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
        onPointerDown={() => onSelect?.(null)}
      />
      {rails.length === 0 && emptyText && (
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={px(12)}
          className="pointer-events-none fill-muted-foreground"
        >
          {emptyText}
        </text>
      )}
      {rails.map((r) => {
        const [top, bottom] = band(r)
        const isSelected = selected === r.key
        const tone = r.invalid
          ? "invalid"
          : isSelected
            ? "selected"
            : r.dimmed
              ? "dimmed"
              : "plain"
        return (
          <Tooltip key={r.key}>
            <TooltipTrigger asChild>
              <g
                data-rail={r.label}
                data-selected={isSelected || undefined}
                data-invalid={r.invalid || undefined}
                data-dimmed={r.dimmed || undefined}
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? "button" : undefined}
                aria-label={interactive ? `Rail ${r.label}` : undefined}
                className={cn(
                  "outline-none",
                  interactive && "cursor-grab touch-none active:cursor-grabbing"
                )}
                onPointerDown={(e) => startDrag(r, e)}
                onPointerMove={(e) => continueDrag(r, e)}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onLostPointerCapture={endDrag}
                onFocus={() => onSelect?.(r.key)}
                onKeyDown={(e) => nudge(r, e)}
              >
                <rect
                  x={r.x_mm}
                  y={top}
                  width={r.length_mm}
                  height={bottom - top}
                  rx={px(2)}
                  className={TONE[tone]}
                  strokeWidth={isSelected ? 2 : 1}
                  vectorEffect="non-scaling-stroke"
                />
                {railLabels && (
                  <text
                    x={r.x_mm + px(6)}
                    y={r.y_mm}
                    dominantBaseline="central"
                    fontSize={px(11)}
                    className={cn(
                      "pointer-events-none font-medium",
                      r.dimmed ? "fill-muted-foreground/60" : "fill-foreground"
                    )}
                  >
                    {r.label}
                  </text>
                )}
              </g>
            </TooltipTrigger>
            <TooltipContent
              variant="panel"
              side="top"
              // The tip follows a rail the arrow keys move.
              updatePositionStrategy={interactive ? "always" : "optimized"}
            >
              <RailNumbers rail={r} />
            </TooltipContent>
          </Tooltip>
        )
      })}
      <PlatePx.Provider value={px}>{children}</PlatePx.Provider>
    </svg>
  )
}

/** A rail's numbers, for its hover. */
function RailNumbers({ rail }: { rail: ElevationRail }) {
  const rows: [string, number][] = [
    ["Left end", rail.x_mm],
    ["Centreline", rail.y_mm],
    ["Length", rail.length_mm],
  ]
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline gap-2 font-medium">
        {rail.label}
        <span className="font-normal text-muted-foreground">
          {PROFILE_LABELS[rail.profile]}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="num text-right">{fmtMm(value)} mm</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  )
}

/** A pointer's position in plate millimetres; null without a layout (a
 * detached node, a test DOM). */
export function toPlateMm(
  svg: SVGSVGElement | null,
  e: { clientX: number; clientY: number }
): { x: number; y: number } | null {
  try {
    const m = svg?.getScreenCTM()
    if (!m) return null
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  } catch {
    return null
  }
}

/** Screen pixels per millimetre as drawn. The SVG keeps its aspect, so the
 * tighter of its width and height sets the scale. 0 until measured. */
function useDrawnScale(
  ref: RefObject<SVGSVGElement | null>,
  viewW: number,
  viewH: number
): number {
  const [scale, setScale] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === "undefined") return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0)
        setScale(Math.min(r.width / viewW, r.height / viewH))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref, viewW, viewH])
  return scale
}
