import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, apiErrorMessage } from "@/lib/api"
import type { FloorPlanDrawing, FloorPlanDrawingPlacement } from "@/lib/api"
import { Field } from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

import { canvasToDrawing, drawingToCanvas } from "./cad-math"

// Calibrate a unitless (or wrongly scaled) drawing: click two points on it,
// type the real distance between them. The cabinet photo calibration (0.17)
// in two dimensions - two guides become two points, the span the distance.
// Points travel to the server in the SVG's viewBox units, so they hold
// whatever the placement is.

export const DISTANCE_MIN_MM = 1
export const DISTANCE_MAX_MM = 1_000_000

/** The typed distance in mm, or null when it is not one the server takes. */
export function parseDistance(text: string): number | null {
  const v = Number(text.trim().replace(",", "."))
  if (!text.trim() || !Number.isFinite(v)) return null
  return v >= DISTANCE_MIN_MM && v <= DISTANCE_MAX_MM ? v : null
}

/** What the scale would be: mm per drawing unit for two points `distance`
 * mm apart - the server's sum, for the readout. */
export function calibratedScale(
  a: [number, number],
  b: [number, number],
  distanceMm: number
): number | null {
  const span = Math.hypot(b[0] - a[0], b[1] - a[1])
  return span > 0 ? distanceMm / span : null
}

export interface CadCalibration {
  active: boolean
  points: [number, number][]
  distance: string
  setDistance: (v: string) => void
  start: () => void
  cancel: () => void
  /** A canvas click, world px. */
  pick: (pt: { x: number; y: number }) => void
  save: () => void
  saving: boolean
}

export function useCadCalibration(
  planId: string,
  drawing: FloorPlanDrawing | null,
  placement: FloorPlanDrawingPlacement,
  pxPerMm: number
): CadCalibration {
  const qc = useQueryClient()
  const [active, setActive] = useState(false)
  const [points, setPoints] = useState<[number, number][]>([])
  const [distance, setDistance] = useState("")
  const reset = () => {
    setActive(false)
    setPoints([])
    setDistance("")
  }
  const mutation = useMutation({
    mutationFn: (body: {
      a: [number, number]
      b: [number, number]
      distance_mm: number
    }) =>
      api<FloorPlanDrawing>(`/api/floor-plans/${planId}/drawing/calibrate/`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["floor-plan-drawing", planId], d)
      qc.invalidateQueries({ queryKey: ["floor-plan", planId] })
      toast.success("Drawing calibrated")
      reset()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })
  return {
    active,
    points,
    distance,
    setDistance,
    start: () => {
      setPoints([])
      setDistance("")
      setActive(true)
    },
    cancel: reset,
    pick: (pt) => {
      if (!drawing) return
      const p = canvasToDrawing(
        pt,
        drawing.size,
        drawing.mm_per_unit,
        placement,
        pxPerMm
      )
      // A third click starts a new pair.
      setPoints((prev) => (prev.length >= 2 ? [p] : [...prev, p]))
    },
    save: () => {
      const d = parseDistance(distance)
      if (points.length !== 2 || d == null) return
      mutation.mutate({ a: points[0], b: points[1], distance_mm: d })
    },
    saving: mutation.isPending,
  }
}

/** The picked points on the canvas (world px), joined once both are in. */
export function CalibrateMarks({
  drawing,
  placement,
  pxPerMm,
  points,
}: {
  drawing: FloorPlanDrawing
  placement: FloorPlanDrawingPlacement
  pxPerMm: number
  points: [number, number][]
}) {
  const at = points.map((p) =>
    drawingToCanvas(p, drawing.size, drawing.mm_per_unit, placement, pxPerMm)
  )
  return (
    <g data-part="cad-calibrate-marks" pointerEvents="none">
      {at.length === 2 && (
        <line
          x1={at[0][0]}
          y1={at[0][1]}
          x2={at[1][0]}
          y2={at[1][1]}
          stroke="var(--map-accent)"
          strokeWidth={1.5}
          strokeDasharray="6 4"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {at.map(([x, y], i) => (
        <g key={i} transform={`translate(${x},${y})`}>
          <circle
            r={5}
            fill="var(--background)"
            stroke="var(--map-accent)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          <circle r={1.5} fill="var(--map-accent)" />
        </g>
      ))}
    </g>
  )
}

/** The bar over the canvas while calibrating: which point to click, then
 * the distance and Save. */
export function CalibrateBar({ cal }: { cal: CadCalibration }) {
  const bad = cal.distance.trim() !== "" && parseDistance(cal.distance) == null
  const hint =
    cal.points.length === 0
      ? "Click the first point"
      : cal.points.length === 1
        ? "Click the second point"
        : null
  return (
    <div
      data-part="cad-calibrate-bar"
      className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-end gap-3 rounded-lg border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg"
    >
      {hint ? (
        <span className="flex h-7 items-center whitespace-nowrap">{hint}</span>
      ) : (
        <Field
          label="Distance (mm)"
          error={bad ? "1–1,000,000 mm" : undefined}
          className="w-36"
        >
          <Input
            type="number"
            inputMode="decimal"
            min={DISTANCE_MIN_MM}
            max={DISTANCE_MAX_MM}
            step="any"
            autoFocus
            value={cal.distance}
            aria-label="Distance (mm)"
            aria-invalid={bad || undefined}
            onChange={(e) => cal.setDistance(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") cal.save()
            }}
            className="num h-7 text-[12px]"
          />
        </Field>
      )}
      <div className="flex h-7 items-center gap-2">
        {!hint && (
          <Button
            size="sm"
            className="h-7"
            disabled={cal.saving || parseDistance(cal.distance) == null}
            onClick={cal.save}
          >
            {cal.saving ? "Saving…" : "Save"}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={cal.saving}
          onClick={cal.cancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
