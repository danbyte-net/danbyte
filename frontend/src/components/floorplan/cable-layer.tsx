import { memo, useCallback, useId, useMemo, useRef, useState } from "react"

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
  splitLanes,
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
import { CablePickIndex, orderHits, PICK_PX, PICK_TOUCH_PX } from "./cable-pick"
import type { PickHit, PickShape } from "./cable-pick"
import type { Pt } from "./cable-route"
import { routeEnds } from "./plan-label-pass"
import type { Box } from "./plan-labels"
import { readableShape } from "./readable"
import type { ShapeOf } from "./readable"

/** floor-canvas.tsx's CELL. */
const CELL = 40
/** An end's dot on a traced run, screen px (its radius). */
const DOT_PX = 4.5
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

/** Where a pick was made, in client px: the pointer, or the middle of the
 * focused run for a key. */
export interface CablePickAt {
  x: number
  y: number
}

const px = (pts: readonly Pt[]): Pt[] =>
  pts.map(([x, y]) => [x * CELL, y * CELL])

/**
 * The plan's cables: each in its lane along its trays, or an orthogonal
 * elbow between its tiles; shared stretches as one bundle with a count
 * when their lanes would not read; coloured from data; styled by route
 * state; strokes the same width on screen at every zoom.
 *
 * Level of detail by cell size on screen: far draws the traced runs and
 * the runs that ride no tray, bundled where they share a stretch (the
 * trays carry the others' counts); mid draws bundles and single runs; near
 * draws every lane that fits, with labels when they are on. Nothing is
 * culled to the view: every leg of every drawn run is in the drawing.
 *
 * The pointer has one hit-test (cable-pick.ts): every cable whose drawn
 * geometry - lanes, bundles, stubs, short-run markers, end dots, a traced
 * run's own lane - lies within a few screen px of it. One opens at once;
 * several ask which (`onChoose`, the cable chooser), nearest first. A
 * lane over a tile leaves the tile its click; an end dot on its edge does
 * not. A traced cable, or the chooser's row under the pointer (`soloId`),
 * runs in its own lane beside its bundles.
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
  onChoose,
  soloId = null,
  toPlan,
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
  /** A click on several cables at once - a bundle, a cluster of short
   * runs - asks which one (the cable chooser). Without it a bundle fans
   * out into its lanes. */
  onChoose?: (ids: string[], at: CablePickAt) => void
  /** The one cable the chooser's row under the pointer shows: drawn
   * apart from its bundles, above the rest, the others dimmed. */
  soloId?: string | null
  /** A client point on the plan (cells); else the layer's screen matrix. */
  toPlan?: (clientX: number, clientY: number) => Pt | null
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
  const rectOf = useCallback(
    (id: string): Box | null => {
      const t = tileById.get(id)
      if (!t) return null
      const real = { x: t.x, y: t.y, w: t.width, h: t.height }
      if (shapeOf !== undefined) return shapeOf?.(t)?.box ?? real
      return readable ? readableShape(t, pxPerCell).box : real
    },
    [tileById, shapeOf, readable, pxPerCell]
  )
  const shorts = useMemo(
    () => shortRuns(routes, pxPerCell),
    [routes, pxPerCell]
  )

  const colorOf = (id: string) => {
    const cp = byId.get(id)
    return (cp && cableColor(cp, colorBy, palette)) || CABLE_NONE
  }
  const hi = new Set(highlightIds)
  const hov = new Set(hover?.ids ?? [])
  // A run hovered on its own (not through its bundle) draws its whole
  // route; a bundle's members stay under the bundle's.
  const hovOne = new Set(hover && !hover.bundle ? hover.ids : [])
  const solo = soloId && byId.has(soloId) ? soloId : null
  const dim = hi.size > 0 || !!solo
  /** In the focus: traced, or the chooser's row. */
  const lit = (id: string) => hi.has(id) || id === solo

  const enter = (hit: CableHoverHit, at: CableAnchor) => {
    setHover(hit)
    onHover(hit, at)
  }
  const leave = () => {
    setHover(null)
    onHover(null)
  }
  const fan = (key: string) => setFanned((prev) => new Set(prev).add(key))

  // ── The pick: one hit-test over everything drawn ─────────────────────────
  const tileBoxes = useMemo(
    () => tiles.map((t) => rectOf(t.id)).filter((b): b is Box => !!b),
    [tiles, rectOf]
  )
  /** Every drawn piece of every cable, as the layer draws it now. */
  const pickShapes = useMemo(() => {
    const out: PickShape[] = []
    if (!interactive) return out
    const traced = new Set(highlightIds)
    const isLit = (id: string) => traced.has(id) || id === solo
    for (const id of layout.order) {
      const route = routes.get(id)
      if (!route) continue
      if (lod === "far" && !isLit(id) && route.trayIds.length) continue
      const lines = isLit(id)
        ? splitLanes(layout, id, bundled, pxPerCell)
        : pieces.get(id)
      for (const pts of lines ?? []) out.push({ id, pts, r: 1.5 })
      const cp = byId.get(id)
      if (cp)
        for (const e of routeEnds(cp, route, rectOf))
          out.push({ id, pts: [e.at], r: DOT_PX, overTiles: true, dot: true })
    }
    for (const key of bundled) {
      const g = layout.groups.get(key)!
      const r = bundleWidth(g.members.length) / 2
      for (const id of g.members)
        out.push({ id, pts: [g.a, g.b], r, group: key })
    }
    for (const s of stubs) {
      // The dashed run and its arrow, out of the tile's edge.
      const len = (STUB_PX + 5) / pxPerCell
      const tip: Pt = [s.from[0] + s.dir[0] * len, s.from[1] + s.dir[1] * len]
      out.push({ id: s.id, pts: [s.from, tip], r: 1.5 })
    }
    for (const g of shorts) {
      const half = 6 / pxPerCell
      const pts: Pt[] = [
        [g.at[0] - g.dir[0] * half, g.at[1] - g.dir[1] * half],
        [g.at[0] + g.dir[0] * half, g.at[1] + g.dir[1] * half],
      ]
      for (const id of g.ids)
        out.push({
          id,
          pts,
          r: 4,
          overTiles: true,
          group: g.ids.length > 1 ? `short:${g.key}` : undefined,
        })
    }
    return out
  }, [
    interactive,
    highlightIds,
    solo,
    layout,
    routes,
    lod,
    bundled,
    pxPerCell,
    pieces,
    byId,
    rectOf,
    stubs,
    shorts,
  ])
  // Built on the first query after the drawing or the zoom changes - so a
  // zoom in flight builds nothing, and the view once settled builds once.
  const pickIndex = useMemo(() => {
    let index: CablePickIndex | null = null
    return () =>
      (index ??= new CablePickIndex(pickShapes, tileBoxes, pxPerCell))
  }, [pickShapes, tileBoxes, pxPerCell])

  const pickAt = (e: React.PointerEvent): PickHit[] => {
    let p: Pt | null = null
    if (toPlan) p = toPlan(e.clientX, e.clientY)
    else {
      const el = e.currentTarget as SVGGraphicsElement
      const m = "getScreenCTM" in el ? el.getScreenCTM() : null
      if (m) {
        const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(
          m.inverse()
        )
        p = [q.x / CELL, q.y / CELL]
      }
    }
    if (!p) return []
    const r = e.pointerType === "touch" ? PICK_TOUCH_PX : PICK_PX
    const lifted = new Set([...hi, ...hov, ...(solo ? [solo] : [])])
    return orderHits(
      pickIndex().query(p, r, lifted),
      (id) => byId.get(id)?.label
    )
  }
  /** One cable opens (a traced one closes); several ask which. */
  const pick = (hits: PickHit[], at: CablePickAt) => {
    const ids = hits.map((h) => h.id)
    if (ids.length === 1) {
      onSelect(hi.has(ids[0]) ? null : ids[0])
      return
    }
    if (onChoose) {
      onChoose(ids, at)
      return
    }
    // No chooser: the bundles under the pointer fan out into lanes.
    const groups = new Set(hits.flatMap((h) => h.groups))
    const bundles = [...groups].filter((g) => bundled.has(g))
    if (bundles.length) bundles.forEach(fan)
    else onSelect(ids[0])
  }
  const hoverKey = useRef("")
  const pickHover = (e: React.PointerEvent) => {
    const hits = pickAt(e)
    const key = hits.map((h) => h.id).join(" ")
    if (key === hoverKey.current) return
    hoverKey.current = key
    if (!hits.length) {
      leave()
      return
    }
    const ids = hits.map((h) => h.id)
    // Exactly one bundle's members: that bundle, for its popover and edge.
    const g = hits[0].groups.find(
      (gk) =>
        bundled.has(gk) &&
        layout.groups.get(gk)!.members.length === ids.length &&
        hits.every((h) => h.groups.includes(gk))
    )
    enter(ids.length === 1 ? { ids } : { ids, bundle: g ?? "pick" }, {
      clientX: e.clientX,
      clientY: e.clientY,
    })
  }
  const clipId = `cable-pick-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  // A coarse pointer reaches further: the band is a finger's pick wide,
  // so a tap beside a cable lands on the layer.
  const [coarse] = useState(() => {
    if (typeof window === "undefined") return false
    // Not in every host (jsdom has none).
    const mm = (window as { matchMedia?: Window["matchMedia"] }).matchMedia
    return (
      typeof mm === "function" && mm.call(window, "(pointer: coarse)").matches
    )
  })
  const bandPx = coarse ? PICK_TOUCH_PX : PICK_PX

  /** The pick layer: a transparent band round every piece - the lanes
   * clipped out of the tiles, the dots and markers not - and one handler
   * for all of it, so no drawn element races another for a click. */
  const pickLayer = () => {
    const lines: string[] = []
    const over: string[] = []
    const dots: Pt[] = []
    for (const sh of pickShapes) {
      if (sh.group && bundled.has(sh.group)) continue
      if (sh.dot) {
        if (lit(sh.id) || hov.has(sh.id)) dots.push(sh.pts[0])
        continue
      }
      const d = sh.pts
        .map(([x, y], i) => `${i ? "L" : "M"}${x * CELL},${y * CELL}`)
        .join("")
      if (sh.overTiles) over.push(d)
      else lines.push(d)
    }
    const holes = tileBoxes
      .map(
        (b) =>
          `M${b.x * CELL},${b.y * CELL}h${b.w * CELL}v${b.h * CELL}h${-b.w * CELL}Z`
      )
      .join("")
    const band = (key: string, d: string, width: number, clip: boolean) => (
      <path
        key={key}
        d={d}
        fill="none"
        stroke="transparent"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        clipPath={clip ? `url(#${clipId})` : undefined}
      />
    )
    return (
      <g
        data-part="pick"
        style={{ cursor: "pointer" }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const hits = pickAt(e)
          // Nothing near after all: the press is the plan's.
          if (!hits.length) return
          e.stopPropagation()
          pick(hits, { x: e.clientX, y: e.clientY })
        }}
        onPointerMove={pickHover}
        onPointerLeave={() => {
          hoverKey.current = ""
          leave()
        }}
      >
        <clipPath id={clipId}>
          <path d={`M-1e7,-1e7H1e7V1e7H-1e7Z${holes}`} clipRule="evenodd" />
        </clipPath>
        {lines.length > 0 &&
          band("lines", lines.join(""), bandPx * 2 + 3, true)}
        {[...bundled].map((key) => {
          const g = layout.groups.get(key)!
          return band(
            key,
            `M${g.a[0] * CELL},${g.a[1] * CELL}L${g.b[0] * CELL},${g.b[1] * CELL}`,
            bandPx * 2 + bundleWidth(g.members.length),
            true
          )
        })}
        {/* Short runs' markers: a band round them off the tiles, the
            marker itself over them. */}
        {over.length > 0 && band("over", over.join(""), bandPx * 2 + 8, true)}
        {over.length > 0 && band("over-tile", over.join(""), 8, false)}
        {/* A lifted run's end dots, over the tile edges they sit on. */}
        {dots.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * CELL}
            cy={p[1] * CELL}
            r={DOT_PX / k}
            fill="transparent"
          />
        ))}
      </g>
    )
  }

  /** Focus and keys for one drawn element. The pointer is the pick
   * layer's (one hit-test for all of them); the elements take none. */
  const handlers = (
    hit: CableHoverHit,
    mid: Pt,
    activate: (at: CablePickAt) => void
  ) =>
    interactive
      ? {
          tabIndex: 0,
          role: "button",
          onFocus: () => enter(hit, { cell: mid }),
          onBlur: leave,
          onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              activate({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
            } else if (e.key === "Escape") onSelect(null)
          },
          style: { outline: "none" },
        }
      : {}

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
    // A traced member runs beside the bundle (splitLanes); the bundle
    // steps back so the one reads apart from the rest.
    const holds = g.members.some(lit)
    return (
      <g
        key={g.key}
        data-bundle={g.key}
        aria-label={`${n} cables`}
        aria-haspopup={onChoose ? "menu" : undefined}
        opacity={dim ? (holds ? 0.45 : 0.2) : 1}
        pointerEvents="none"
        {...handlers({ ids: g.members, bundle: g.key }, mid, (at) =>
          onChoose ? onChoose(g.members, at) : fan(g.key)
        )}
      >
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
   * ends, its length and, up close, its ports. The keyboard stays on the
   * run's own element below. */
  const lifted = (id: string, traced: boolean) => {
    const cp = byId.get(id)
    const route = routes.get(id)
    // Traced or the chooser's: its own lane, out beside its bundles.
    const lines = lit(id)
      ? splitLanes(layout, id, bundled, pxPerCell)
      : full.get(id)
    if (!cp || !route || !lines?.length) return null
    const color = colorOf(id)
    // The ends' dots where the run leaves each tile, not mid-tile.
    const ends = routeEnds(cp, route, rectOf).map((e) => e.at)
    return (
      <g
        key={`lift-${id}`}
        data-lifted={id}
        data-solo={id === solo && !traced ? id : undefined}
        pointerEvents="none"
      >
        {strokes(id, lines, {
          extra: traced || id === solo ? 1.5 : 1,
          halo: traced || id === solo,
        })}
        {ends.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * CELL}
            cy={p[1] * CELL}
            r={(traced ? DOT_PX : 3.5) / k}
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
    shorts.map((g) => {
      const colors = g.ids.map((id) => {
        const cp = byId.get(id)
        return cp ? cableColor(cp, colorBy, palette) : null
      })
      const color = sharedColor(colors) ?? CABLE_NONE
      const half = 6 / k
      const [x, y] = [g.at[0] * CELL, g.at[1] * CELL]
      const [dx, dy] = [g.dir[0] * half, g.dir[1] * half]
      const holds = g.ids.some(lit)
      return (
        <g
          key={`short-${g.key}`}
          data-short={g.ids.join(" ")}
          aria-label={
            g.ids.length > 1
              ? `${g.ids.length} cables`
              : ariaFor(byId.get(g.ids[0]))
          }
          opacity={dim && !holds ? 0.2 : 1}
          pointerEvents="none"
          {...handlers(
            g.ids.length > 1 ? { ids: g.ids, bundle: g.key } : { ids: g.ids },
            g.at,
            (at) =>
              g.ids.length > 1
                ? onChoose
                  ? onChoose(g.ids, at)
                  : onSelect(null)
                : onSelect(hi.has(g.ids[0]) ? null : g.ids[0])
          )}
        >
          <path
            d={`M${x - dx},${y - dy}L${x + dx},${y + dy}`}
            stroke="var(--background)"
            strokeWidth={6}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={`M${x - dx},${y - dy}L${x + dx},${y + dy}`}
            stroke={color}
            strokeWidth={3.5}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
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
    const raised = traced || hov.has(s.id) || s.id === solo
    return (
      <g
        key={`stub-${s.id}`}
        data-stub={s.id}
        aria-label={`${ariaFor(cp)} - far end not on this plan`}
        aria-pressed={interactive ? traced : undefined}
        opacity={dim && !traced && s.id !== solo ? 0.2 : 1}
        pointerEvents="none"
        {...handlers({ ids: [s.id] }, mid, () =>
          onSelect(traced ? null : s.id)
        )}
      >
        <path
          d={`M${x0},${y0}L${x1},${y1}`}
          fill="none"
          stroke={color}
          strokeWidth={raised ? 3 : 2}
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
      {[...bundled].map((key) => bundleView(layout.groups.get(key)!))}
      {/* The runs' casing: a background edge under every line, all
          before any line, so a run reads over a map or a photo while the
          lanes of a tray stay side by side. */}
      <g data-part="casing" pointerEvents="none">
        {layout.order.map((id) => {
          if (lit(id) || hovOne.has(id) || hov.has(id)) return null
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
        if (lod === "far" && !lit(id) && routes.get(id)?.trayIds.length)
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
            opacity={dim && !lit(id) ? 0.2 : 1}
            pointerEvents="none"
            {...handlers({ ids: [id] }, mid, () =>
              onSelect(hi.has(id) ? null : id)
            )}
          >
            {!(up || hov.has(id) || id === solo) && strokes(id, lines)}
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
      {[...hov]
        .filter((id) => !hi.has(id) && id !== solo)
        .map((id) => lifted(id, false))}
      {highlightIds.map((id) => lifted(id, true))}
      {solo && !hi.has(solo) && lifted(solo, false)}
      {previews && [...previews].map(([id, route]) => previewView(id, route))}
      {interactive && pickLayer()}
    </g>
  )
})
