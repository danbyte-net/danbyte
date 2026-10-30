import { memo, useMemo, useState } from "react"

import type { FloorPlanCablePath } from "@/lib/api"

import {
  CABLE_LINE,
  CABLE_NONE,
  LANE_MIN_PX,
  bundleWidth,
  bundledGroups,
  cableColor,
  cableLod,
  cableRouteState,
  endText,
  formatMetres,
  laneOrder,
  lanePolylines,
  layoutCables,
  longestLegMid,
  roundedPath,
  routeLengthM,
  sharedColor,
  typePalette,
} from "./cable-draw"
import type { CableColorBy, CableRoute, LaneGroup } from "./cable-draw"
import type { Pt } from "./cable-route"

/** floor-canvas.tsx's CELL. */
const CELL = 40
/** The hit band around a run, screen px. */
const HIT_PX = 14
/** Rounded corners, plan px. */
const FILLET = 6

/** What the pointer or the keyboard is on: one cable, or a bundle's. */
export interface CableHoverHit {
  ids: string[]
  /** The bundle's group, when the hit is a bundle. */
  bundle?: string
}

/** Where a hover is anchored: the pointer (client px), or a point on the
 * plan (cells) when the keyboard focused it. */
export type CableAnchor = { clientX: number; clientY: number } | { cell: Pt }

const px = (pts: readonly Pt[]): Pt[] =>
  pts.map(([x, y]) => [x * CELL, y * CELL])

/**
 * The plan's cables: each in its lane along its trays, or an orthogonal
 * elbow between its tiles; shared stretches as one bundle with a count
 * when their lanes would not read; coloured from data; styled by route
 * state; strokes the same width on screen at every zoom.
 *
 * Level of detail by cell size on screen: far draws only the traced runs
 * (the trays carry the counts); mid draws bundles and single runs; near
 * draws every lane that fits, with labels when they are on.
 *
 * Memoised on its props: the canvas re-renders on every pan frame and this
 * layer does not - it lays the routes out once per change of the routes.
 */
export const CableLayer = memo(function CableLayer({
  cablePaths,
  routes,
  k,
  cellMm,
  colorBy,
  bundle,
  showLabels,
  highlightIds,
  interactive,
  onSelect,
  onHover,
}: {
  cablePaths: readonly FloorPlanCablePath[]
  routes: ReadonlyMap<string, CableRoute>
  /** The canvas zoom: screen px per plan px. */
  k: number
  cellMm: number
  colorBy: CableColorBy
  bundle: boolean
  showLabels: boolean
  highlightIds: readonly string[]
  interactive: boolean
  onSelect: (id: string | null) => void
  onHover: (hit: CableHoverHit | null, at?: CableAnchor) => void
}) {
  const byId = useMemo(
    () => new Map(cablePaths.map((cp) => [cp.id, cp])),
    [cablePaths]
  )
  const palette = useMemo(() => typePalette(cablePaths), [cablePaths])
  const layout = useMemo(
    () => layoutCables(routes, laneOrder(cablePaths, routes)),
    [routes, cablePaths]
  )
  const [fanned, setFanned] = useState<ReadonlySet<string>>(() => new Set())
  const [hover, setHover] = useState<CableHoverHit | null>(null)

  const pxPerCell = CELL * k
  const lod = cableLod(pxPerCell)
  const minGapCells = LANE_MIN_PX / pxPerCell
  const bundled = useMemo(
    () => bundledGroups(layout, { lod, bundle, minGapCells, fanned }),
    [layout, lod, bundle, minGapCells, fanned]
  )
  // Each cable's lanes: whole, and without what its bundles draw.
  const full = useMemo(
    () =>
      new Map(
        layout.order.map((id) => [id, lanePolylines(layout.cables.get(id)!)])
      ),
    [layout]
  )
  const pieces = useMemo(
    () =>
      new Map(
        layout.order.map((id) => [
          id,
          lanePolylines(
            layout.cables.get(id)!,
            (s) => !!s.group && bundled.has(s.group)
          ),
        ])
      ),
    [layout, bundled]
  )

  const colorOf = (id: string) => {
    const cp = byId.get(id)
    return (cp && cableColor(cp, colorBy, palette)) || CABLE_NONE
  }
  const hi = new Set(highlightIds)
  const hov = new Set(hover?.ids ?? [])
  // A run hovered on its own (not through its bundle) swaps its hit band
  // for its whole route; a bundle's members stay under the bundle's.
  const hovOne = new Set(hover && !hover.bundle ? hover.ids : [])
  const dim = hi.size > 0

  const enter = (hit: CableHoverHit, at: CableAnchor) => {
    setHover(hit)
    onHover(hit, at)
  }
  const leave = () => {
    setHover(null)
    onHover(null)
  }
  const fan = (key: string) => setFanned((prev) => new Set(prev).add(key))

  /** Pointer, focus and keys for one hit target. */
  const handlers = (
    hit: CableHoverHit,
    mid: Pt,
    activate: () => void,
    focusable = true
  ) =>
    interactive
      ? {
          tabIndex: focusable ? 0 : undefined,
          role: focusable ? "button" : undefined,
          onPointerDown: (e: React.PointerEvent) => {
            e.stopPropagation()
            activate()
          },
          onPointerEnter: (e: React.PointerEvent) =>
            enter(hit, { clientX: e.clientX, clientY: e.clientY }),
          onPointerLeave: leave,
          onFocus: () => enter(hit, { cell: mid }),
          onBlur: leave,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              activate()
            } else if (e.key === "Escape") onSelect(null)
          },
          style: { cursor: "pointer", outline: "none" },
        }
      : { style: { cursor: "default" } }

  const ariaFor = (cp: FloorPlanCablePath | undefined) =>
    cp
      ? `Cable ${cp.label}: ${endText(cp.a_points)} to ${endText(cp.b_points)}`
      : "Cable"

  /** One cable's lanes in its colour and style. */
  const strokes = (
    id: string,
    lines: Pt[][],
    { extra = 0, halo = false }: { extra?: number; halo?: boolean } = {}
  ) => {
    const cp = byId.get(id)
    const style = CABLE_LINE[cp ? cableRouteState(cp) : "inferred"]
    const color = colorOf(id)
    return lines.map((line, i) => {
      const d = roundedPath(px(line), FILLET)
      return (
        <g key={i} pointerEvents="none">
          {halo && (
            <path
              d={d}
              fill="none"
              stroke={color}
              strokeOpacity={0.25}
              strokeWidth={style.width + 7}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          )}
          <path
            d={d}
            fill="none"
            stroke={color}
            strokeOpacity={extra ? 1 : style.opacity}
            strokeWidth={style.width + extra}
            strokeDasharray={style.dash}
            strokeLinecap={style.cap}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )
    })
  }

  const hitPaths = (lines: Pt[][]) =>
    interactive &&
    lines.map((line, i) => (
      <path
        key={`h${i}`}
        d={roundedPath(px(line), FILLET)}
        fill="none"
        stroke="transparent"
        strokeWidth={HIT_PX}
        vectorEffect="non-scaling-stroke"
      />
    ))

  /** A chip of text at a plan point, the same size at every zoom. */
  const chip = (key: string, at: Pt, text: string, color?: string) => {
    const w = text.length * 5.6 + 8
    return (
      <g
        key={key}
        transform={`translate(${at[0] * CELL},${at[1] * CELL}) scale(${1 / k})`}
        pointerEvents="none"
      >
        <rect
          x={-w / 2}
          y={-8}
          width={w}
          height={16}
          rx={3}
          fill="var(--background)"
          stroke={color ?? "var(--border)"}
          strokeWidth={1}
        />
        <text
          y={3.5}
          textAnchor="middle"
          fontSize={10}
          fill="var(--foreground)"
        >
          {text}
        </text>
      </g>
    )
  }

  const bundleView = (g: LaneGroup) => {
    const colors = g.members.map((id) => {
      const cp = byId.get(id)
      return cp ? cableColor(cp, colorBy, palette) : null
    })
    const color = sharedColor(colors) ?? CABLE_NONE
    const planned = g.members.every(
      (id) => byId.get(id)?.status?.is_planned === true
    )
    const line: Pt[] = [g.a, g.b]
    const mid: Pt = [(g.a[0] + g.b[0]) / 2, (g.a[1] + g.b[1]) / 2]
    const len = Math.hypot(g.b[0] - g.a[0], g.b[1] - g.a[1]) * pxPerCell
    const n = g.members.length
    const lit = g.members.some((id) => hi.has(id))
    return (
      <g
        key={g.key}
        data-bundle={g.key}
        aria-label={`${n} cables`}
        opacity={dim && !lit ? 0.2 : 1}
        {...handlers({ ids: g.members, bundle: g.key }, mid, () => fan(g.key))}
      >
        {hitPaths([line])}
        <path
          d={roundedPath(px(line), 0)}
          fill="none"
          stroke={color}
          strokeOpacity={hover?.bundle === g.key ? 1 : 0.85}
          strokeWidth={bundleWidth(n) + (hover?.bundle === g.key ? 1.5 : 0)}
          strokeDasharray={planned ? CABLE_LINE.planned.dash : undefined}
          strokeLinecap={planned ? "butt" : "round"}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        {/* The count, as the squarish badge - only where it fits. */}
        {len >= 28 && chip("n", mid, String(n), color)}
      </g>
    )
  }

  // Labels at near detail: each single run's name at its longest leg,
  // skipped where it would sit on one already placed.
  const labels: React.ReactNode[] = []
  if (showLabels && lod === "near") {
    const boxes: { x: number; y: number; w: number; h: number }[] = []
    for (const id of layout.order) {
      if (labels.length >= 200) break
      const cp = byId.get(id)
      const lines = pieces.get(id)
      if (!cp || !lines?.length || (dim && !hi.has(id))) continue
      const best = lines
        .map((l) => longestLegMid(l))
        .sort((x, y) => y.len - x.len)[0]
      if (best.len * pxPerCell < 60) continue
      const w = (cp.label.length * 5.6 + 8) / pxPerCell
      const h = 16 / pxPerCell
      const box = { x: best.at[0] - w / 2, y: best.at[1] - h / 2, w, h }
      if (
        boxes.some(
          (b) =>
            b.x < box.x + box.w &&
            box.x < b.x + b.w &&
            b.y < box.y + box.h &&
            box.y < b.y + b.h
        )
      )
        continue
      boxes.push(box)
      labels.push(chip(`l-${id}`, best.at, cp.label, colorOf(id)))
    }
  }

  /** A run lifted above the rest - traced or under the pointer - with its
   * ends, its length and, up close, its ports. A traced run keeps a hit
   * band on top, so a click on it lands on it where others share its tray;
   * the keyboard stays on the run's own element below. */
  const lifted = (id: string, traced: boolean) => {
    const cp = byId.get(id)
    const route = routes.get(id)
    const lines = full.get(id)
    if (!cp || !route || !lines) return null
    const color = colorOf(id)
    const a = route.points[0]
    const b = route.points[route.points.length - 1]
    const mid = longestLegMid(route.points)
    return (
      <g
        key={`lift-${id}`}
        data-lifted={id}
        pointerEvents={traced ? undefined : "none"}
        {...(traced
          ? handlers({ ids: [id] }, mid.at, () => onSelect(null), false)
          : {})}
      >
        {traced && hitPaths(lines)}
        {strokes(id, lines, { extra: traced ? 1.5 : 1, halo: traced })}
        {[a, b].map((p, i) => (
          <circle
            key={i}
            cx={p[0] * CELL}
            cy={p[1] * CELL}
            r={(traced ? 4.5 : 3.5) / k}
            fill={color}
            stroke="var(--background)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        ))}
        {lod !== "far" &&
          chip("len", mid.at, formatMetres(routeLengthM(route, cellMm)), color)}
        {lod === "near" &&
          [
            [a, endText(cp.a_points)],
            [b, endText(cp.b_points)],
          ].map(([p, text], i) =>
            chip(
              `end-${i}`,
              [(p as Pt)[0], (p as Pt)[1] - 14 / pxPerCell],
              text as string
            )
          )}
      </g>
    )
  }

  return (
    <g data-layer="cables" data-lod={lod}>
      {lod !== "far" &&
        [...bundled].map((key) => bundleView(layout.groups.get(key)!))}
      {/* One element per run, in lane order, that stays put while it is
          hovered or traced - so the keyboard keeps its place - and draws
          only while it is neither (the lifted copy above draws it then). */}
      {layout.order.map((id) => {
        const up = hi.has(id) || hovOne.has(id)
        if (lod === "far" && !hi.has(id)) return null
        const lines = up ? full.get(id) : pieces.get(id)
        if (!lines?.length) return null
        const cp = byId.get(id)
        const mid = longestLegMid(lines[0]).at
        return (
          <g
            key={id}
            data-cable={id}
            aria-label={ariaFor(cp)}
            aria-pressed={interactive ? hi.has(id) : undefined}
            opacity={dim && !hi.has(id) ? 0.2 : 1}
            {...handlers({ ids: [id] }, mid, () =>
              onSelect(hi.has(id) ? null : id)
            )}
          >
            {hitPaths(lines)}
            {!(up || hov.has(id)) && strokes(id, lines)}
          </g>
        )
      })}
      {labels}
      {[...hov].filter((id) => !hi.has(id)).map((id) => lifted(id, false))}
      {highlightIds.map((id) => lifted(id, true))}
    </g>
  )
})
