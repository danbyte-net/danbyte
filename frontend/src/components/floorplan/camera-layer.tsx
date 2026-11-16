import { memo, useEffect, useId, useMemo, useRef, useState } from "react"

import type { FloorPlanTile, FloorPlanWall } from "@/lib/api"
import { LegendRow } from "@/components/map-legend"

import { CELL } from "./canvas-geometry"
import { cameraViews, formatCoverage, polygonPath } from "./camera-view"
import { BareFrame } from "./plan-legend"
import type { CameraView } from "./camera-view"
import type { Pt } from "./shapes"

// The cameras' fields of view on the 2D plan, cut short by walls
// (camera-view.ts), and the blind spots of Display > Camera coverage.

const NO_VIEWS: CameraView[] = []

/** Every camera's view, recomputed at most every `throttleMs` while the
 * tiles or walls change (a drag) - the last change always lands. Cached
 * per camera, so a camera nothing moved near costs nothing. */
export function useCameraViews(
  tiles: readonly FloorPlanTile[],
  walls: readonly FloorPlanWall[],
  opts: { cellMm: number; racksBlock: boolean; enabled: boolean },
  throttleMs = 0
): CameraView[] {
  const { cellMm, racksBlock, enabled } = opts
  const compute = () =>
    enabled ? cameraViews(tiles, walls, { cellMm, racksBlock }) : NO_VIEWS
  const direct = useMemo(
    () => (throttleMs ? null : compute()),
    [tiles, walls, cellMm, racksBlock, enabled, throttleMs]
  )
  const [held, setHeld] = useState<CameraView[]>(() =>
    throttleMs ? compute() : NO_VIEWS
  )
  const last = useRef(0)
  useEffect(() => {
    if (!throttleMs) return
    const wait = Math.max(0, last.current + throttleMs - performance.now())
    const id = window.setTimeout(() => {
      last.current = performance.now()
      setHeld(compute())
    }, wait)
    return () => window.clearTimeout(id)
  }, [tiles, walls, cellMm, racksBlock, enabled, throttleMs])
  return direct ?? held
}

/** The canvas's camera layer: the cones, or the blind spots, of the views
 * against the walls as shown - recomputed at most every 40 ms while
 * something is dragged. Its own component, so a pan or a zoom (which
 * re-renders the canvas) never touches it, and its updates re-render only
 * it. */
export const LiveCameraLayer = memo(function LiveCameraLayer({
  part,
  tiles,
  walls,
  cellMm,
  racksBlock,
  regions,
  width,
  height,
  showSeen = false,
  only = null,
}: {
  part: "cones" | "coverage"
  /** Cones: only these cameras' (Detail by zoom: the hovered or selected
   * one); null draws every one. */
  only?: ReadonlySet<string> | null
  tiles: readonly FloorPlanTile[]
  walls: readonly FloorPlanWall[]
  cellMm: number
  racksBlock: boolean
  /** Coverage: the floor measured, in cells, and the grid. */
  regions?: readonly Pt[][]
  width?: number
  height?: number
  showSeen?: boolean
}) {
  const views = useCameraViews(
    tiles,
    walls,
    { cellMm, racksBlock, enabled: true },
    40
  )
  if (part === "cones")
    return (
      <CameraCones views={only ? views.filter((v) => only.has(v.id)) : views} />
    )
  return (
    <CoverageOverlay
      views={views}
      regions={regions ?? []}
      width={width ?? 0}
      height={height ?? 0}
      showSeen={showSeen}
    />
  )
})

/** The views as the plan draws them: the camera's colour, translucent,
 * with a dashed edge - a ring fainter than a cone. */
export function CameraCones({ views }: { views: readonly CameraView[] }) {
  return (
    <g pointerEvents="none" data-camera-views="">
      {views.map((v) => (
        <path
          key={v.id}
          data-fov={v.id}
          d={polygonPath(v.polygon, CELL)}
          fill={v.color}
          fillOpacity={v.ring ? 0.08 : 0.12}
          stroke={v.color}
          strokeOpacity={0.45}
          strokeWidth={1}
          strokeDasharray="4 3"
          strokeLinejoin="round"
        />
      ))}
    </g>
  )
}

/** Display > Camera coverage: the floor no camera sees, tinted; with the
 * cones hidden, the floor seen tinted too. */
export function CoverageOverlay({
  views,
  regions,
  width,
  height,
  showSeen,
}: {
  views: readonly CameraView[]
  /** The floor measured, in cells. */
  regions: readonly Pt[][]
  /** The grid, in cells. */
  width: number
  height: number
  showSeen: boolean
}) {
  const id = useId().replace(/:/g, "")
  // One path each: two outlines wound opposite ways would cancel in one.
  const floor = regions.map((r, i) => (
    <path key={i} d={polygonPath(r, CELL)} fill="white" />
  ))
  const seen = views.map((v) => polygonPath(v.polygon, CELL))
  const box = { x: 0, y: 0, width: width * CELL, height: height * CELL }
  return (
    <g pointerEvents="none" data-coverage="">
      <defs>
        <mask id={`blind-${id}`} maskUnits="userSpaceOnUse" {...box}>
          {floor}
          {seen.map((d, i) => (
            <path key={i} d={d} fill="black" />
          ))}
        </mask>
        {showSeen && (
          <mask id={`seen-${id}`} maskUnits="userSpaceOnUse" {...box}>
            {floor}
          </mask>
        )}
      </defs>
      <rect
        {...box}
        className="fill-destructive"
        fillOpacity={0.2}
        mask={`url(#blind-${id})`}
        data-blind=""
      />
      {showSeen && seen.length > 0 && (
        <g mask={`url(#seen-${id})`}>
          {seen.map((d, i) => (
            <path
              key={i}
              d={d}
              className="fill-emerald-500"
              fillOpacity={0.14}
            />
          ))}
        </g>
      )}
    </g>
  )
}

/** The plan legend's section under Display > Camera coverage: how much of
 * the floor (its areas, or the grid) the cameras see, and the blind tint. */
export function CoverageLegend({ share }: { share: number }) {
  return (
    <BareFrame>
      <p className="pb-1 font-medium whitespace-nowrap">Camera coverage</p>
      <div className="space-y-0.5" data-coverage-legend="">
        <LegendRow
          swatch={
            <span className="h-3 w-5 shrink-0 rounded-sm border border-border" />
          }
          label={
            <span className="whitespace-nowrap">
              Seen <span className="num">{formatCoverage(share)}</span>
            </span>
          }
        />
        <LegendRow
          swatch={
            <span className="h-3 w-5 shrink-0 rounded-sm bg-destructive/25" />
          }
          label={<span className="whitespace-nowrap">Blind spot</span>}
        />
      </div>
    </BareFrame>
  )
}
