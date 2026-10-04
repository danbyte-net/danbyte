import { useRef, useState } from "react"
import type { KeyboardEvent, PointerEvent, ReactNode } from "react"
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react"

import type { DinRail } from "@/lib/api"
import {
  SNAP_MM,
  fitRange,
  flushIn,
  fmtMm,
  freeGaps,
  gapStep,
  roundMm,
  snapFlush,
} from "@/lib/din-geometry"
import type { RailNeighbour } from "@/lib/din-geometry"
import { useContentWidth } from "@/lib/use-content-width"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** A drag snaps from this many screen pixels, even past SNAP_MM. */
const SNAP_PX = 6
/** Screen pixels a press travels before it drags. */
const DRAG_SLOP_PX = 3
/** The thumb never draws narrower than this, in px. */
const MIN_THUMB_PX = 10

/**
 * The offset as a slider along the rail (#277), under the cabinet's plate:
 * the track is the rail, the devices on it muted stretches, and the thumb
 * this device, as wide as it is - red where it overlaps one. A drag keeps
 * the thumb where it was picked up and snaps it flush as the plate's
 * outline does; the keys step it a millimetre (Shift: 10), PageUp and
 * PageDown jump to the next or previous gap it fits in, Home and End to the
 * first and last place it fits. Beside it, the same jumps and flush against
 * either end of its gap, as buttons.
 */
export function RailSlider({
  rail,
  width,
  neighbours,
  offset,
  clash,
  onPreview,
  onSettle,
  onPlace,
}: {
  rail: DinRail
  /** The device's width, in mm. */
  width: number
  /** The other devices on the rail. */
  neighbours: RailNeighbour[]
  /** Where the device is, from the rail's left end. */
  offset: number
  /** It overlaps a neighbour, or runs off the rail. */
  clash: boolean
  /** A drag moving the device; null once it ends. */
  onPreview: (offset: number | null) => void
  /** A drag let go here - fitted into the gap under it, or refused. */
  onSettle: (offset: number, tolerance: number) => void
  /** A key or a button put the device here. */
  onPlace: (offset: number) => void
}) {
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const trackPx = useContentWidth(box)
  const length = rail.length_mm
  const max = Math.max(0, roundMm(length - width))
  const pxPerMm = trackPx / length
  const tolerance = pxPerMm > 0 ? Math.max(SNAP_MM, SNAP_PX / pxPerMm) : SNAP_MM
  const taken = neighbours.map((n) => n.span)
  const gaps = freeGaps(length, taken)
  const prev = gapStep(gaps, width, offset, -1)
  const next = gapStep(gaps, width, offset, 1)
  const left = flushIn(gaps, width, offset, -1)
  const right = flushIn(gaps, width, offset, 1)
  const range = fitRange(gaps, width)
  const keep = (v: number) => roundMm(Math.min(Math.max(v, 0), max))

  // A drag on the thumb is ours: it keeps the thumb where it was picked up,
  // where the slider would jump its middle to the pointer. A press on the
  // track is the slider's, settled the same way when it lets go.
  const drag = useRef<{
    pointerId: number
    startX: number
    /** Where the press landed on the device, mm from its left edge. */
    grab: number
    moved: boolean
    at: number
  } | null>(null)
  const pressing = useRef(false)
  const mmAt = (clientX: number) =>
    box ? (clientX - box.getBoundingClientRect().left) / pxPerMm : 0

  const pointerDown = (e: PointerEvent<HTMLSpanElement>) => {
    const onThumb = (e.target as Element).closest("[data-slot=slider-thumb]")
    if (!onThumb) {
      pressing.current = true
      return
    }
    if (e.button !== 0 || pxPerMm <= 0) return
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      grab: mmAt(e.clientX) - offset,
      moved: false,
      at: offset,
    }
  }

  const pointerMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    e.preventDefault()
    if (!d.moved && Math.abs(e.clientX - d.startX) < DRAG_SLOP_PX) return
    d.moved = true
    const at = snapFlush(
      keep(Math.round(mmAt(e.clientX) - d.grab)),
      width,
      length,
      taken,
      tolerance
    )
    if (at === d.at) return
    d.at = at
    onPreview(at)
  }

  const pointerUp = (e: PointerEvent<HTMLSpanElement>) => {
    if (pressing.current) {
      // The slider commits a press on the track after this, if it moved.
      pressing.current = false
      onPreview(null)
      return
    }
    const d = drag.current
    if (!d || d.pointerId !== e.pointerId) return
    e.preventDefault()
    drag.current = null
    onPreview(null)
    if (d.moved) onSettle(d.at, tolerance)
  }

  const keyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    const by = e.shiftKey ? 10 : 1
    const to: Record<string, number | null | undefined> = {
      ArrowLeft: offset - by,
      ArrowDown: offset - by,
      ArrowRight: offset + by,
      ArrowUp: offset + by,
      PageUp: next,
      PageDown: prev,
      Home: range?.[0],
      End: range?.[1],
    }
    if (!(e.key in to)) return
    // Ours, not the slider's: it would step by tens and go to the rail's
    // ends, over devices.
    e.preventDefault()
    const v = to[e.key]
    if (v != null) onPlace(keep(v))
  }

  const thumbPx = Math.max(MIN_THUMB_PX, width * pxPerMm)
  const edges = `${fmtMm(offset)}–${fmtMm(offset + width)} mm`

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <SliderButton
        label="Previous gap"
        onClick={() => prev != null && onPlace(prev)}
        disabled={prev == null}
      >
        <ChevronsLeft />
      </SliderButton>
      <SliderButton
        label="Flush left"
        onClick={() => left != null && onPlace(left)}
        disabled={left == null || left === offset}
      >
        <ArrowLeftToLine />
      </SliderButton>
      <div ref={setBox} className="mx-1.5 min-w-0 flex-1">
        <Slider
          data-part="rail-slider"
          min={0}
          max={max}
          step={1}
          value={[keep(offset)]}
          onValueChange={([v]) => {
            if (!drag.current)
              onPreview(snapFlush(v, width, length, taken, tolerance))
          }}
          onValueCommit={([v]) =>
            onSettle(snapFlush(v, width, length, taken, tolerance), tolerance)
          }
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onKeyDown={keyDown}
          // The range from 0 to the device means nothing here.
          className="[&_[data-slot=slider-range]]:hidden"
          track={neighbours.map(({ name, span: [s, e] }) => (
            <span
              key={`${name}-${s}`}
              data-part="taken"
              className="absolute inset-y-0 bg-muted-foreground/40"
              style={{
                left: `${(s / length) * 100}%`,
                width: `${((e - s) / length) * 100}%`,
              }}
            />
          ))}
          thumbProps={{
            "aria-label": "Offset",
            "aria-valuetext": edges,
            className: cn(
              "h-4 rounded-sm border-2 shadow-none hover:ring-0",
              clash
                ? "border-destructive bg-destructive/25"
                : "border-primary bg-primary/20"
            ),
            style: { width: thumbPx },
          }}
        />
      </div>
      <SliderButton
        label="Flush right"
        onClick={() => right != null && onPlace(right)}
        disabled={right == null || right === offset}
      >
        <ArrowRightToLine />
      </SliderButton>
      <SliderButton
        label="Next gap"
        onClick={() => next != null && onPlace(next)}
        disabled={next == null}
      >
        <ChevronsRight />
      </SliderButton>
    </div>
  )
}

/** An icon-only button beside the slider, named by its tooltip. */
function SliderButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button takes no hover: the span keeps the tip. */}
        <span className="inline-flex">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            aria-label={label}
            onClick={onClick}
            disabled={disabled}
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" variant="default">
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
