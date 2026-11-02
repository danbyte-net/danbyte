import { memo, useMemo, useState } from "react"

import type { FloorPlanCablePath, FloorPlanTile } from "@/lib/api"

import {
  CABLE_LINE,
  CABLE_NONE,
  LANE_MIN_PX,
  bundleWidth,
  bundledGroups,
  cableColor,
  cableLod,
  drawnRouteState,
  endText,
  formatMetres,
  laneOrder,
  lanePolylines,
  layoutCables,
  longestLegMid,
  roundedPath,
  routeLengthM,
  sharedColor,
  shortRuns,
  STUB_PX,
  typePalette,
} from "./cable-draw"
import type {
  CableColorBy,
  CableRoute,
  CableStub,
  LaneGroup,
} from "./cable-draw"
import type { Pt } from "./cable-route"
import { routeEnds } from "./plan-label-pass"
import type { Box } from "./plan-labels"
import { readableShape } from "./readable"
import type { ShapeOf } from "./readable"

/** floor-canvas.tsx's CELL. */
const CELL = 40
/** The hit band around a run, screen px. */
const HIT_PX = 14
/** Rounded corners, plan px. */
const FILLET = 6
/** A run's casing: this much wider than its line, screen px. */
const CASING_PX = 2

const NO_STUBS: readonly CableStub[] = []
const NO_TILES: readonly FloorPlanTile[] = []

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
 * Level of detail by cell size on screen: far draws the traced runs and
 * the runs that ride no tray (the trays carry the others' counts); mid
 * draws bundles and single runs; near draws every lane that fits, with
 * labels when they are on.
 *
 * From afar a run too short to see draws as a marker between its ends (a
 * count beside it where several meet), and a cable with one end here as
 * a stub from that end's tile, pointing out, with an off-plan arrow.
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
  highlightIds,
  interactive,
  onSelect,
  onHover,
  previews,
  stubs = NO_STUBS,
  tiles = NO_TILES,
  readable = false,
  shapeOf,
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
  /** Routes computed but not saved, drawn dotted over the plan. */
  previews?: ReadonlyMap<string, CableRoute>
  /** Cables with one end on this plan (cable-draw.ts cableStubs). */
  stubs?: readonly CableStub[]
  /** The tiles, for where a run leaves its end's tile - the end's dot. */
  tiles?: readonly FloorPlanTile[]
  /** Readable: an end's tile as its grown symbol. */
  readable?: boolean
  /** How a tile draws when not as itself (Readable, icon tiles); wins over
   * `readable`. */
  shapeOf?: ShapeOf | null
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

  const tileById = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles])
  /** An end's tile as drawn (cells): grown under Readable. */
  const rectOf = (id: string): Box | null => {
    const t = tileById.get(id)
    if (!t) return null
    const real = { x: t.x, y: t.y, w: t.width, h: t.height }
    if (shapeOf !== undefined) return shapeOf?.(t)?.box ?? real
    return readable ? readableShape(t, pxPerCell).box : real
  }

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
    const style =
      CABLE_LINE[cp ? drawnRouteState(cp, routes.get(id)) : "inferred"]
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
          stroke="var(--background)"
          strokeOpacity={0.85}
          strokeWidth={bundleWidth(n) + CASING_PX}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
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
      </g>
    )
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
    // The ends' dots where the run leaves each tile, not mid-tile.
    const ends = routeEnds(cp, route, rectOf).map((e) => e.at)
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
        {ends.map((p, i) => (
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
      </g>
    )
  }

  /** An out-of-date route's moved ends: a warning mark where the path
   * ends, and a dashed connector to where its tile is now. */
  const staleMarks = (id: string, moved: { at: Pt; now: Pt }[]) => (
    <g key={`stale-${id}`} data-stale={id} pointerEvents="none">
      {moved.map((m, i) => (
        <g key={i}>
          <path
            d={`M${m.at[0] * CELL},${m.at[1] * CELL}L${m.now[0] * CELL},${m.now[1] * CELL}`}
            fill="none"
            className="stroke-amber-500"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            cx={m.at[0] * CELL}
            cy={m.at[1] * CELL}
            r={4.5 / k}
            className="fill-amber-500"
            stroke="var(--background)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        </g>
      ))}
    </g>
  )

  /** A route computed but not saved: dotted in the cable's colour over an
   * accent outline, with its length at mid-run. */
  const previewView = (id: string, route: CableRoute) => {
    const style = CABLE_LINE.preview
    const color = colorOf(id)
    const d = roundedPath(px(route.points), FILLET)
    const mid = longestLegMid(route.points)
    return (
      <g key={`preview-${id}`} data-preview={id} pointerEvents="none">
        <path
          d={d}
          fill="none"
          stroke="var(--primary)"
          strokeOpacity={0.35}
          strokeWidth={style.width + 4}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={d}
          fill="none"
          stroke={color}
          strokeOpacity={style.opacity}
          strokeWidth={style.width}
          strokeDasharray={style.dash}
          strokeLinecap={style.cap}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {lod !== "far" &&
          chip(
            "len",
            mid.at,
            formatMetres(routeLengthM(route, cellMm)),
            "var(--primary)"
          )}
      </g>
    )
  }

  /** Runs too short to see: a short bar between their ends in their
   * colour, with a count where several meet. */
  const shortView = () =>
    shortRuns(routes, pxPerCell).map((g) => {
      const colors = g.ids.map((id) => {
        const cp = byId.get(id)
        return cp ? cableColor(cp, colorBy, palette) : null
      })
      const color = sharedColor(colors) ?? CABLE_NONE
      const half = 6 / k
      const [x, y] = [g.at[0] * CELL, g.at[1] * CELL]
      const [dx, dy] = [g.dir[0] * half, g.dir[1] * half]
      const lit = g.ids.some((id) => hi.has(id))
      return (
        <g
          key={`short-${g.key}`}
          data-short={g.ids.join(" ")}
          aria-label={
            g.ids.length > 1
              ? `${g.ids.length} cables`
              : ariaFor(byId.get(g.ids[0]))
          }
          opacity={dim && !lit ? 0.2 : 1}
          {...handlers(
            g.ids.length > 1 ? { ids: g.ids, bundle: g.key } : { ids: g.ids },
            g.at,
            () =>
              g.ids.length > 1
                ? onSelect(null)
                : onSelect(hi.has(g.ids[0]) ? null : g.ids[0])
          )}
        >
          {interactive && (
            <circle cx={x} cy={y} r={10 / k} fill="transparent" />
          )}
          <path
            d={`M${x - dx},${y - dy}L${x + dx},${y + dy}`}
            stroke="var(--background)"
            strokeWidth={6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          <path
            d={`M${x - dx},${y - dy}L${x + dx},${y + dy}`}
            stroke={color}
            strokeWidth={3.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
          {g.ids.length > 1 &&
            chip(
              "n",
              [g.at[0], g.at[1] - 14 / pxPerCell],
              String(g.ids.length),
              color
            )}
        </g>
      )
    })

  /** A cable with one end here: a dashed stub out of its tile in its
   * colour, ending in an arrow - the run leaves the plan. */
  const stubView = (s: CableStub) => {
    const cp = byId.get(s.id)
    const color = colorOf(s.id)
    const len = STUB_PX / k
    const [x0, y0] = [s.from[0] * CELL, s.from[1] * CELL]
    const [x1, y1] = [x0 + s.dir[0] * len, y0 + s.dir[1] * len]
    const ah = 5 / k
    const [nx, ny] = [-s.dir[1], s.dir[0]]
    const tip = `M${x1 + s.dir[0] * ah},${y1 + s.dir[1] * ah}L${x1 + nx * ah},${y1 + ny * ah}L${x1 - nx * ah},${y1 - ny * ah}Z`
    const mid: Pt = [
      s.from[0] + (s.dir[0] * len) / 2 / CELL,
      s.from[1] + (s.dir[1] * len) / 2 / CELL,
    ]
    const traced = hi.has(s.id)
    const lit = traced || hov.has(s.id)
    return (
      <g
        key={`stub-${s.id}`}
        data-stub={s.id}
        aria-label={`${ariaFor(cp)} - far end not on this plan`}
        aria-pressed={interactive ? traced : undefined}
        opacity={dim && !traced ? 0.2 : 1}
        {...handlers({ ids: [s.id] }, mid, () =>
          onSelect(traced ? null : s.id)
        )}
      >
        {interactive && (
          <path
            d={`M${x0},${y0}L${x1},${y1}`}
            stroke="transparent"
            strokeWidth={HIT_PX}
            vectorEffect="non-scaling-stroke"
          />
        )}
        <path
          d={`M${x0},${y0}L${x1},${y1}`}
          fill="none"
          stroke={color}
          strokeWidth={lit ? 3 : 2}
          strokeDasharray="4 3"
          strokeLinecap="butt"
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
        <path
          d={tip}
          fill={color}
          stroke="var(--background)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          pointerEvents="none"
        />
      </g>
    )
  }

  return (
    <g data-layer="cables" data-lod={lod}>
      {lod !== "far" &&
        [...bundled].map((key) => bundleView(layout.groups.get(key)!))}
      {/* The runs' casing: a background edge under every line, all
          before any line, so a run reads over a map or a photo while the
          lanes of a tray stay side by side. */}
      <g data-part="casing" pointerEvents="none">
        {layout.order.map((id) => {
          if (hi.has(id) || hovOne.has(id) || hov.has(id)) return null
          if (lod === "far" && routes.get(id)?.trayIds.length) return null
          const lines = pieces.get(id)
          if (!lines?.length) return null
          const cp = byId.get(id)
          const style =
            CABLE_LINE[cp ? drawnRouteState(cp, routes.get(id)) : "inferred"]
          return lines.map((line, i) => (
            <path
              key={`${id}-${i}`}
              d={roundedPath(px(line), FILLET)}
              fill="none"
              stroke="var(--background)"
              strokeOpacity={dim ? 0.3 : 0.85}
              strokeWidth={style.width + CASING_PX}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          ))
        })}
      </g>
      {/* One element per run, in lane order, that stays put while it is
          hovered or traced - so the keyboard keeps its place - and draws
          only while it is neither (the lifted copy above draws it then). */}
      {layout.order.map((id) => {
        const up = hi.has(id) || hovOne.has(id)
        if (lod === "far" && !hi.has(id) && routes.get(id)?.trayIds.length)
          return null
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
      {stubs.map(stubView)}
      {shortView()}
      {lod !== "far" &&
        layout.order.map((id) => {
          const route = routes.get(id)
          if (!route?.stale || !route.moved?.length) return null
          if (dim && !hi.has(id)) return null
          return staleMarks(id, route.moved)
        })}
      {[...hov].filter((id) => !hi.has(id)).map((id) => lifted(id, false))}
      {highlightIds.map((id) => lifted(id, true))}
      {previews && [...previews].map(([id, route]) => previewView(id, route))}
    </g>
  )
})
