import { useRef } from "react"
import type { KeyboardEvent, PointerEvent, RefObject } from "react"

import { moveGuide, nudgeGuide, parseSpan } from "@/lib/photo-calibration"
import type { Guide, Guides } from "@/lib/photo-calibration"
import { cn } from "@/lib/utils"
import { Field } from "@/components/forms"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

// Calibrate mode in the photo editor (#277): two guides across the photo and
// the rail line along it, drawn over the picture in fractions of it, and the
// bar that takes the real distance between the guides.

const LABEL: Record<Guide, string> = {
  left: "Left guide",
  right: "Right guide",
  rail: "Rail line",
}

/** The keys that move each guide, and which way. */
const KEYS: Record<Guide, Partial<Record<string, -1 | 1>>> = {
  left: { ArrowLeft: -1, ArrowRight: 1 },
  right: { ArrowLeft: -1, ArrowRight: 1 },
  rail: { ArrowUp: -1, ArrowDown: 1 },
}

const pct = (v: number) => `${v * 100}%`

/**
 * The guides over the photo: the two across its width (drag them sideways,
 * or focus one and use ←/→) and the rail line (drag it, or ↑/↓), Shift for
 * coarser steps. With `band`, the rail's true height is shaded around the
 * rail line. Read-only without `onChange`; an inherited calibration is
 * drawn faded.
 */
export function CalibrationGuides({
  guides,
  band,
  inherited,
  boxRef,
  onChange,
}: {
  guides: Guides
  /** The rail's height as a fraction of the photo's; null draws none. */
  band: number | null
  /** The type's calibration, which the device inherits. */
  inherited?: boolean
  /** The photo, to turn the pointer into fractions of it. */
  boxRef: RefObject<HTMLElement | null>
  onChange?: (next: Guides) => void
}) {
  const drag = useRef<{ guide: Guide; pointerId: number } | null>(null)

  const fractionAt = (guide: Guide, e: PointerEvent<HTMLElement>) => {
    const box = boxRef.current?.getBoundingClientRect()
    if (!box || box.width <= 0 || box.height <= 0) return null
    return guide === "rail"
      ? (e.clientY - box.top) / box.height
      : (e.clientX - box.left) / box.width
  }

  const handlers = (guide: Guide) => {
    if (!onChange) return {}
    const end = (e: PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === e.pointerId) drag.current = null
    }
    return {
      onPointerDown: (e: PointerEvent<HTMLElement>) => {
        if (e.button !== 0) return
        e.stopPropagation()
        e.currentTarget.setPointerCapture(e.pointerId)
        e.currentTarget.focus()
        drag.current = { guide, pointerId: e.pointerId }
      },
      onPointerMove: (e: PointerEvent<HTMLElement>) => {
        const d = drag.current
        if (d?.guide !== guide || d.pointerId !== e.pointerId) return
        const at = fractionAt(guide, e)
        if (at != null) onChange(moveGuide(guides, guide, at))
      },
      onPointerUp: end,
      onPointerCancel: end,
      onLostPointerCapture: end,
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
        const direction = KEYS[guide][e.key]
        if (!direction) return
        e.preventDefault()
        e.stopPropagation()
        onChange(nudgeGuide(guides, guide, direction, e.shiftKey))
      },
    }
  }

  // Each guide hangs off a zero-size anchor at its position. The line sits a
  // pixel's share left of (or above) it, so a guide on the photo's very edge
  // still shows inside it, and the handles sit on the photo's side of the
  // line: the left guide's to its right, the right guide's to its left.
  const guide = (g: Guide) => {
    const across = g !== "rail"
    const at = guides[g]
    return (
      <div
        key={g}
        className="absolute"
        style={
          across
            ? { left: pct(at), top: 0, bottom: 0 }
            : { top: pct(at), left: 0, right: 0 }
        }
      >
        <div
          role="slider"
          aria-label={LABEL[g]}
          aria-orientation={across ? "horizontal" : "vertical"}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(at * 1000) / 10}
          aria-readonly={!onChange || undefined}
          tabIndex={onChange ? 0 : -1}
          data-guide={g}
          className={cn(
            "group/guide absolute outline-none",
            across ? "inset-y-0 w-3" : "inset-x-0 h-3",
            onChange &&
              cn(
                "pointer-events-auto touch-none",
                across ? "cursor-ew-resize" : "cursor-ns-resize"
              )
          )}
          style={across ? { left: g === "left" ? -4 : -8 } : { top: -6 }}
          onClick={(e) => e.stopPropagation()}
          {...handlers(g)}
        >
          <span
            className={cn(
              "absolute border-primary",
              across ? "inset-y-0 border-l" : "inset-x-0 border-t border-dashed"
            )}
            style={
              across ? { left: (g === "left" ? 4 : 8) - at } : { top: 6 - at }
            }
          />
          <span
            className="absolute size-2.5 rounded-[2px] border border-background bg-primary group-focus-visible/guide:ring-2 group-focus-visible/guide:ring-ring"
            style={
              across
                ? g === "left"
                  ? { top: 0, left: 4 }
                  : { top: 0, left: -2 }
                : { left: 0, top: 1 }
            }
          />
        </div>
      </div>
    )
  }

  return (
    <div
      data-part="calibration-guides"
      data-inherited={inherited || undefined}
      className={cn(
        "pointer-events-none absolute inset-0",
        inherited && "opacity-60"
      )}
    >
      {band != null && (
        <div
          data-part="rail-band"
          className="absolute inset-x-0 border-y border-primary/50 bg-primary/15"
          style={{ top: pct(guides.rail - band / 2), height: pct(band) }}
        />
      )}
      {(["rail", "left", "right"] as const).map(guide)}
    </div>
  )
}

/**
 * The calibrate bar over the photo: the real distance between the guides,
 * what that makes the photo, and Clear calibration. `readout` is null until
 * the photo's size is known.
 */
export function CalibrationBar({
  span,
  onSpan,
  readout,
  inherited,
  onClear,
}: {
  span: string
  /** Absent = read-only. */
  onSpan?: (text: string) => void
  readout: string | null
  /** The type's calibration, which the device inherits. */
  inherited?: boolean
  onClear?: () => void
}) {
  const bad = span.trim() !== "" && parseSpan(span) == null
  return (
    <div
      data-part="calibration-bar"
      className="flex flex-wrap items-end gap-x-4 gap-y-2 rounded-lg border border-border bg-card p-3"
    >
      <Field
        label="Distance (mm)"
        error={bad ? "1–5000 mm" : undefined}
        className="w-32"
      >
        <Input
          type="number"
          inputMode="decimal"
          step={0.1}
          min={1}
          max={5000}
          value={span}
          disabled={!onSpan}
          aria-label="Distance (mm)"
          aria-invalid={bad || undefined}
          onChange={(e) => onSpan?.(e.target.value)}
          className="num h-7 text-[12px]"
        />
      </Field>
      <div className="flex h-7 items-center gap-2">
        {readout && (
          <span
            data-part="calibration-readout"
            className="num text-[12px] whitespace-nowrap"
          >
            {readout}
          </span>
        )}
        {inherited && <Badge variant="secondary">From type</Badge>}
      </div>
      {onClear && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto h-7 text-[12px]"
          onClick={onClear}
        >
          Clear calibration
        </Button>
      )}
    </div>
  )
}
