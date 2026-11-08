import type {
  FloorPlanCableEnd,
  FloorPlanCablePath,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"

import { endText, formatMetres, routeLengthM } from "./cable-draw"
import type { CableLayout, CableRoute, LaneGroup } from "./cable-draw"
import type { Pt } from "./cable-route"
import { CELL, tileIsZone, tileName } from "./canvas-geometry"
import {
  Occupancy,
  RANK,
  alongSlots,
  aroundSpots,
  besideSpots,
  cableLegs,
  endChipSpots,
  insideSpots,
  placeLabels,
  polylineLegs,
  textSize,
  tileExit,
} from "./plan-labels"
import type {
  AlongSpot,
  Box,
  Edge,
  LabelRequest,
  LabelSpot,
} from "./plan-labels"
import {
  BoxIndex,
  CALLOUT_MAX_LINES,
  boxGap,
  CALLOUT_MAX_LEADER,
  calloutClusters,
  calloutGroups,
  calloutSize,
  layoutCallouts,
  leaderBoxes,
} from "./plan-callouts"
import type { CalloutItem, CalloutLine, CalloutSide } from "./plan-callouts"
import { READABLE_SYMBOL_PX, clipName, namePriority } from "./readable"
import type { ShapeOf } from "./readable"
import { areaIcon, areaName, polygonCentroid, shapeBounds } from "./shapes"
import type { AreaShape, LabelShape } from "./shapes"

// The plan's one label pass (plan-labels.ts), shared by the canvas and the
// paper export: what each kind of text is, where it may go and how it
// ranks. The caller draws what comes back.

/** A cable's two ends as drawn: where its run leaves each end's tile (the
 * drawn box - grown under Readable), the tile, and the end's ports. */
export interface RouteEnd {
  at: Pt
  edge: Edge | null
  tile: string | null
  rect: Box | null
  points: readonly FloorPlanCableEnd[]
}

export function routeEnds(
  cp: FloorPlanCablePath,
  route: CableRoute,
  rectOf: (tileId: string) => Box | null | undefined
): [RouteEnd, RouteEnd] {
  const leg = cp.path?.legs[0]
  const fromTile = leg?.from.tile ?? cp.a_tiles.at(0) ?? null
  const toTile = leg?.to.tile ?? cp.b_tiles.at(0) ?? null
  const fromB = leg?.from.end === "B"
  const pts = route.points
  const end = (
    tile: string | null,
    run: readonly Pt[],
    points: readonly FloorPlanCableEnd[]
  ): RouteEnd => {
    const rect = (tile && rectOf(tile)) || null
    if (!rect) return { at: run[0], edge: null, tile, rect, points }
    const exit = tileExit(run, rect)
    return { at: exit.at, edge: exit.edge, tile, rect, points }
  }
  return [
    end(fromTile, pts, fromB ? cp.b_points : cp.a_points),
    end(toTile, [...pts].reverse(), fromB ? cp.a_points : cp.b_points),
  ]
}

/** A text along a line, as drawn: centre (cells), angle, the text and a
 * muted suffix (a cable's length, up close). */
export interface AlongLabel {
  key: string
  id: string
  at: Pt
  angle: number
  text: string
  suffix?: string
}

/** A text at a point (cells): its centre. */
export interface PointLabel {
  key: string
  id: string
  at: Pt
  text: string
}

export interface PlanLabelInput {
  /** Units per cell: screen px (CELL * k) or paper mm (CELL * mmPerPx). */
  scale: number
  /** Units per plan px (k, or mmPerPx). */
  unitsPerPx: number
  /** Fonts (units): names along lines and under tiles; end chips. */
  font: number
  chipFont: number
  /** A name repeats every this many units along a long run. */
  repeat: number
  /** Breathing room between a text and what it sits by (units). */
  gap: number
  /** In view (units), on the canvas; the paper lays out everything. */
  view?: Box | null
  /** The plan's grid, or a live view's crop or room (units): names go
   * inside it first, past its edge only when nothing fits inside, and
   * never off-screen (out of `view`) when a spot on screen exists. */
  bounds?: Box | null
  /** Only inside `bounds` (paper: its frame clips the rest). */
  boundsOnly?: boolean
  /** Where the plan shows (units), when it is clipped there (a live
   * view's grid): a name along a run or a tray stays inside it, as the
   * line it rides does. `bounds` when absent. */
  clip?: Box | null
  tiles: readonly FloorPlanTile[]
  /** How Readable draws a tile, or null under Real. */
  shapeOf?: ShapeOf | null
  /** Icons when zoomed out: the tiles drawn as icons. Their names go
   * round their own icon, never over another. */
  iconIds?: ReadonlySet<string>
  /** Icons folded into one cluster tile: its drawn box (cells), its name
   * and its members - who name no more on their own. */
  iconClusters?: readonly IconClusterLabel[]
  /** A zone's name grown by this much (Readable from afar). */
  zoneGrow?: number
  /** Tile names scaled to fill their tile (Display > Fit labels). */
  labelFit?: boolean
  /** Tiles whose name always shows: the selection, the hovered. */
  pinnedTiles?: ReadonlySet<string>
  trays?: readonly FloorPlanTray[]
  /** A tray's channel width (units): its name sits beside it. */
  trayWidth?: number
  areas?: readonly AreaShape[]
  /** Area names' font (plan px, grown under Readable). */
  areaFontPx?: number
  raised?: readonly { id: string; box: Box; text: string; fontPx: number }[]
  planLabels?: readonly LabelShape[]
  cellMm: number
  cables?: {
    paths: readonly FloorPlanCablePath[]
    routes: ReadonlyMap<string, CableRoute>
    layout: CableLayout
    /** Groups drawn as one bundle. */
    bundled: ReadonlySet<string>
    /** Names on runs other than the focus (Display > Cable labels). */
    names: boolean
    /** The traced, selected and hovered: always named, their ends too. */
    focus: ReadonlySet<string>
    /** Only the focus is drawn (far): no other names or bundles. */
    focusOnly?: boolean
    /** Up close: the length as a muted suffix. */
    lengths: boolean
    /** Their ends' ports in chips beside the tiles. */
    ends: boolean
  }
  /** Callouts (the canvas, Display > Callouts: Auto): a tile whose name
   * will not sit cleanly by it is named in a box set off to the side, a
   * leader back to it, its `lines` under the name. */
  callouts?: {
    lines?: ReadonlyMap<string, readonly CalloutLine[]>
  } | null
}

/** A callout as drawn: its box's centre (cells) and size (px, constant
 * on screen), its name and lines, the side of its room it sits on and its
 * leader's two ends (cells): the box's edge, the tile's. */
export interface CalloutLabel {
  id: string
  name: string
  lines: readonly CalloutLine[]
  at: Pt
  size: { w: number; h: number }
  side: CalloutSide
  leader: [Pt, Pt]
}

/** A cluster tile, for the label pass. */
export interface IconClusterLabel {
  id: string
  box: Box
  name: string
  members: readonly string[]
}

export interface PlanLabels {
  cables: AlongLabel[]
  bundles: AlongLabel[]
  trays: AlongLabel[]
  ends: PointLabel[]
  /** Names drawn by this layer (grown or photo tiles under Readable). */
  tiles: PointLabel[]
  /** Tiles whose name this layer draws - the tile leaves out its own. */
  tileNamesHere: Set<string>
  /** Each area's name: its box's top left (cells), or null to hide it;
   * missing: where it always is. */
  areas: Map<string, Pt | null>
  /** Raised-floor captions that would cover another text. */
  hiddenRaised: Set<string>
  /** The tiles named in a callout instead (their name not drawn). */
  callouts: CalloutLabel[]
  /** Every box taken (units), for a caller laying out more. */
  taken: readonly Box[]
}

const boxOfCells = (b: Box, scale: number): Box => ({
  x: b.x * scale,
  y: b.y * scale,
  w: b.w * scale,
  h: b.h * scale,
})

/** A tile's name drawn inside its tile (TileShape): roughly where. */
function inTileNameBox(
  t: FloorPlanTile,
  name: string,
  labelFit: boolean,
  zoneGrow = 1
): Box {
  const w = t.width * CELL
  const h = t.height * CELL
  let font = 11
  if (labelFit)
    font = Math.max(
      5,
      Math.min(h * 0.55, (w - 8) / (Math.max(1, name.length) * 0.62))
    )
  if (tileIsZone(t)) {
    const g = zoneGrow
    const tw = name.length * 10 * g * 0.62
    return {
      x: t.x * CELL + 6 * g,
      y: t.y * CELL + 4 * g,
      w: g > 1 ? tw : Math.min(w - 12, tw),
      h: 13 * g,
    }
  }
  if (t.display === "photo" && t.photo) {
    const tw = name.length * 9 * 0.62
    return {
      x: t.x * CELL + w / 2 - tw / 2,
      y: (t.y + t.height) * CELL + 1,
      w: tw,
      h: 12,
    }
  }
  const tw = Math.min(w - 8, name.length * font * 0.62)
  return {
    x: t.x * CELL + w / 2 - tw / 2,
    y: t.y * CELL + h / 2 - font * 0.55,
    w: tw,
    h: font * 1.1,
  }
}

/** The rooms a callout goes round (units): the areas linked to a room -
 * a plain area (an aisle, a zone) or a building outline is no room. */
function roomBoxes(
  areas: readonly AreaShape[],
  cellMm: number,
  scale: number
): { id: string; box: Box }[] {
  return areas
    .filter((a) => !!a.room)
    .map((a) => {
      const b = shapeBounds(a, cellMm)
      return {
        id: a.id,
        box: boxOfCells(
          { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
          scale
        ),
      }
    })
}

const contains = (o: Box, b: Box) =>
  b.x >= o.x - 1e-6 &&
  b.y >= o.y - 1e-6 &&
  b.x + b.w <= o.x + o.w + 1e-6 &&
  b.y + b.h <= o.y + o.h + 1e-6

/** `spots` best first: inside `bounds` before past its edge, the rest in
 * their own order; off-screen ones left out while one on screen exists. */
export function preferInside<T>(
  spots: readonly LabelSpot<T>[],
  bounds: Box | null | undefined,
  view: Box | null | undefined,
  only = false
): LabelSpot<T>[] {
  let out = [...spots]
  if (bounds && only) return out.filter((s) => contains(bounds, s.box))
  if (view) {
    const shown = out.filter((s) => contains(view, s.box))
    if (shown.length) out = shown
  }
  if (bounds) {
    const inside = out.filter((s) => contains(bounds, s.box))
    if (inside.length && inside.length < out.length)
      out = [...inside, ...out.filter((s) => !contains(bounds, s.box))]
  }
  return out
}

/** Callout layouts kept, by what they were laid out from (the canvas and
 * the paper export each keep theirs). */
const CALLOUT_CACHE = 4
const calloutCache = new Map<
  string,
  { callouts: CalloutLabel[]; calledOut: string[]; taken: Box[] }
>()

/** A name drawn in its tile below this on screen (px) can't be read. */
export const MIN_IN_TILE_NAME_PX = 8

/** The pass: plan labels, then the cables (the focus first), the tiles'
 * fixed names, the trays, the tiles' movable names, the areas, the raised
 * floors - each at its first free place, or hidden. */
export function layoutPlanLabels(input: PlanLabelInput): PlanLabels {
  const { scale, unitsPerPx: u, font, gap, view, bounds } = input
  const inside = <T>(spots: readonly LabelSpot<T>[]) =>
    preferInside(spots, bounds, view, input.boundsOnly)
  // Names along a run or a tray: only where the line they ride shows.
  const along = <T>(spots: readonly LabelSpot<T>[]) =>
    preferInside(spots, input.clip ?? bounds, view, true)
  const occ = new Occupancy(Math.max(16, font * 6))
  const reqs: LabelRequest<unknown>[] = []
  const inView = (b: Box) =>
    !view ||
    (b.x < view.x + view.w &&
      b.x + b.w > view.x &&
      b.y < view.y + view.h &&
      b.y + b.h > view.y)

  // What callouts must keep off, whatever the view: the plan labels and
  // the names fixed in their tiles, everywhere on the plan - so a pan
  // never moves a callout.
  const fixedBoxes: Box[] = []

  // Plan labels: never hidden - there first.
  for (const l of input.planLabels ?? []) {
    const b = shapeBounds(l, input.cellMm)
    const box = boxOfCells(
      { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
      scale
    )
    fixedBoxes.push(box)
    if (!inView(box)) continue
    reqs.push({
      id: `label:${l.id}`,
      priority: RANK.planLabel,
      force: true,
      spots: [{ box, data: null }],
    })
  }

  // Tiles: a name drawn in the tile stays put; under Readable a grown or
  // photo tile's name is ours to place round its symbol.
  const tileNamesHere = new Set<string>()
  const tileBodies: Box[] = []
  const tileReqs: LabelRequest<{ at: Pt }>[] = []
  const tileText = new Map<string, string>()
  // A zone's name is drawn in the zone, but gives way to an icon or a
  // callout: hidden (drawn by "this layer", which draws nothing).
  const zoneNames = new Set<string>()
  // The icons and cluster tiles: a name never goes over one.
  const clustered = new Set(
    (input.iconClusters ?? []).flatMap((c) => c.members)
  )
  const icons = new Occupancy(Math.max(16, font * 6))
  for (const c of input.iconClusters ?? []) icons.add(boxOfCells(c.box, scale))
  for (const t of input.tiles) {
    if (!input.iconIds?.has(t.id) || clustered.has(t.id)) continue
    const box = input.shapeOf?.(t)?.box
    if (box) icons.add(boxOfCells(box, scale))
  }
  // Callouts: every tile whose name we place, wherever it is, tried as a
  // plain name first (`trial`), with its drawn box (units).
  const wantCallouts = !!input.callouts
  // With callouts, a name kept by its tile was cleared against the fixed
  // text, the other names and the callouts: it outranks the trays' and the
  // cables' names, which would otherwise hide it there.
  const named = wantCallouts ? RANK.cableStored + 5e5 : RANK.tile
  const trial: LabelRequest<{ at: Pt }>[] = []
  const ours: { id: string; box: Box; home: Box; text: string }[] = []
  const bodies = new BoxIndex(Math.max(16, font * 6))
  // What `bodies` holds, for the callouts' cache key.
  const bodyList: [string, Box][] = []
  const addBody = (id: string, b: Box) => {
    bodies.add(id, b)
    bodyList.push([id, b])
  }
  for (const c of input.iconClusters ?? [])
    addBody(c.id, boxOfCells(c.box, scale))
  for (const t of input.tiles) {
    const name = tileName(t)
    const shape = input.shapeOf?.(t)
    const zone = tileIsZone(t)
    const drawn = shape?.box ?? { x: t.x, y: t.y, w: t.width, h: t.height }
    if (!zone) tileBodies.push(boxOfCells(drawn, scale))
    // In a cluster: the cluster names it.
    if (clustered.has(t.id)) {
      tileNamesHere.add(t.id)
      continue
    }
    if (!zone) addBody(t.id, boxOfCells(drawn, scale))
    if (!name) continue
    const b = inTileNameBox(t, name, !!input.labelFit, input.zoneGrow)
    // Icons off and zoomed out: a name drawn in its tile is too small to
    // read, so with callouts on it is placed (and called out) like an
    // icon's - beside its tile, or in a box.
    const tiny = wantCallouts && !zone && b.h * u < MIN_IN_TILE_NAME_PX
    const ours_ =
      tiny ||
      (!!shape &&
        !zone &&
        (shape.changed || (t.display === "photo" && !!t.photo)))
    if (!ours_) {
      const box = { x: b.x * u, y: b.y * u, w: b.w * u, h: b.h * u }
      if (!zone) fixedBoxes.push(box)
      if (!inView(box)) continue
      if (zone) zoneNames.add(t.id)
      reqs.push({
        id: `tilefix:${t.id}`,
        priority: RANK.tileFixed,
        // A zone's name yields to an icon or a callout over it.
        force: !zone,
        block: zone ? icons : undefined,
        spots: [{ box, data: null }],
      })
      continue
    }
    tileNamesHere.add(t.id)
    const text = clipName(name)
    tileText.set(t.id, text)
    const icon = !!input.iconIds?.has(t.id)
    const all = (icon ? aroundSpots : besideSpots)(
      drawn,
      textSize(text, font),
      gap / 2,
      scale
    )
    if (wantCallouts) {
      ours.push({
        id: t.id,
        box: boxOfCells(drawn, scale),
        home: boxOfCells({ x: t.x, y: t.y, w: t.width, h: t.height }, scale),
        text,
      })
      trial.push({
        id: `tile:${t.id}`,
        priority: RANK.tile + namePriority(t),
        spots: preferInside(all, bounds, null, input.boundsOnly),
        block: icon ? icons : undefined,
      })
    }
    const spots = inside(all)
    if (!spots.some((s) => inView(s.box))) continue
    const pinned = !!input.pinnedTiles?.has(t.id)
    tileReqs.push({
      id: `tile:${t.id}`,
      priority: pinned ? RANK.tilePinned : named + namePriority(t),
      force: pinned,
      spots,
      block: icon ? icons : undefined,
    })
  }
  for (const c of input.iconClusters ?? []) {
    const text = clipName(c.name)
    tileText.set(c.id, text)
    const all = aroundSpots(c.box, textSize(text, font), gap / 2, scale)
    // Over a single rack's name: it stands for several.
    const priority = named + 1000 + Math.min(999, c.members.length)
    if (wantCallouts)
      trial.push({
        id: `tile:${c.id}`,
        priority,
        spots: preferInside(all, bounds, null, input.boundsOnly),
        block: icons,
      })
    const spots = inside(all)
    if (!spots.some((s) => inView(s.box))) continue
    tileReqs.push({ id: `tile:${c.id}`, priority, spots, block: icons })
  }

  // Callouts: a name with no place by its tile, or one as near another
  // tile as its own (which could be either's), goes in a box off to the
  // side. Decided and laid out over the whole plan, not the view - a few
  // rounds, as the boxes and their leaders can crowd out a name that sat
  // clear before.
  const callouts: CalloutLabel[] = []
  const calledOut = new Set<string>()
  const lines = input.callouts?.lines
  const rooms = wantCallouts
    ? roomBoxes(input.areas ?? [], input.cellMm, scale)
    : []
  // Fills `callouts` and `calledOut`; returns the boxes taken (the boxes
  // and their leaders).
  const layOut = (): Box[] => {
    const cell = Math.max(16, font * 6)
    // Nearer another tile than this (units) beyond its own: ambiguous.
    const margin = font
    const join = READABLE_SYMBOL_PX * 1.5
    const toCells = (p: Pt): Pt => [p[0] / scale, p[1] / scale]
    // Boxes and leaders placed so far.
    const taken: Box[] = []
    const calloutBoxes: Box[] = []
    // Clear of every tile, icon and fixed text.
    const solid = new Occupancy(cell)
    for (const b of fixedBoxes) solid.add(b)
    for (const b of tileBodies) solid.add(b)
    for (const cl of input.iconClusters ?? [])
      solid.add(boxOfCells(cl.box, scale))
    const gaveUp = new Set<string>()
    const leaders: [Pt, Pt][] = []
    // Tiles near each other read as one cluster: when one of them is
    // named in a callout, all of them are - never boxes and plain names
    // mixed in one cluster.
    const clusterOf = calloutClusters(ours, join)
    const place = (items: CalloutItem[], maxLeader: number) =>
      layoutCallouts(items, {
        free: (b) => solid.free(b),
        bounds: input.boundsOnly ? bounds : null,
        prior: calloutBoxes,
        priorLeaders: leaders,
        bodies,
        maxLeader,
      })
    type Placed = NonNullable<
      ReturnType<typeof place> extends Map<string, infer V> ? V : never
    >
    const commit = (it: CalloutItem, p: Placed) => {
      calledOut.add(it.id)
      leaders.push(p.leader)
      const lb = leaderBoxes(p.leader)
      taken.push(p.box, ...lb)
      calloutBoxes.push(p.box)
      solid.add(p.box)
      for (const b of lb) solid.add(b)
      callouts.push({
        id: it.id,
        name: tileText.get(it.id) ?? "",
        lines: (lines?.get(it.id) ?? []).slice(0, CALLOUT_MAX_LINES),
        at: toCells([p.box.x + p.box.w / 2, p.box.y + p.box.h / 2]),
        size: { w: p.box.w, h: p.box.h },
        side: p.side,
        leader: [toCells(p.leader[0]), toCells(p.leader[1])],
      })
    }
    for (let round = 0; round < 3; round++) {
      const fixed = new Occupancy(cell)
      for (const b of fixedBoxes) fixed.add(b)
      for (const b of taken) fixed.add(b)
      const tried = placeLabels(
        trial.filter((r) => !calledOut.has(r.id.slice(5))),
        fixed
      )
      const unclear = ours.filter((o) => {
        if (calledOut.has(o.id) || gaveUp.has(o.id)) return false
        const spot = tried.get(`tile:${o.id}`)
        if (!spot) return true
        const own = boxGap(spot.box, o.box)
        return bodies.near(spot.box, own + margin, o.id).length > 0
      })
      // Their clusters whole, and the rest of a cluster called out before.
      const boxed = new Set(
        [...unclear.map((o) => o.id), ...calledOut].map((id) =>
          clusterOf.get(id)
        )
      )
      const want = ours.filter(
        (o) =>
          !calledOut.has(o.id) &&
          !gaveUp.has(o.id) &&
          boxed.has(clusterOf.get(o.id))
      )
      if (!want.length) break
      const groups = calloutGroups(
        want.map((o) => ({ id: o.id, anchor: o.box, home: o.home })),
        rooms,
        join,
        gap * 2
      )
      const items: CalloutItem[] = want.map((o) => {
        const g = groups.get(o.id)!
        return {
          id: o.id,
          anchor: o.box,
          size: calloutSize(
            o.text,
            (lines?.get(o.id) ?? []).slice(0, CALLOUT_MAX_LINES)
          ),
          group: g.group,
          container: g.container,
        }
      })
      const placed = place(items, CALLOUT_MAX_LEADER)
      for (const it of items) {
        const p = placed.get(it.id)
        if (!p) {
          // Nowhere for a box either: its plain name, if it fits.
          gaveUp.add(it.id)
          continue
        }
        commit(it, p)
      }
    }
    // A cluster called out with one of its tiles left without a box: one
    // more try for each, with a longer leader, before it goes unnamed.
    const boxedNow = new Set([...calledOut].map((id) => clusterOf.get(id)))
    for (const o of ours) {
      if (!gaveUp.has(o.id) || !boxedNow.has(clusterOf.get(o.id))) continue
      const it: CalloutItem = {
        id: o.id,
        anchor: o.box,
        size: calloutSize(
          o.text,
          (lines?.get(o.id) ?? []).slice(0, CALLOUT_MAX_LINES)
        ),
        group: `lone:${o.id}`,
        container: o.box,
      }
      const p = place([it], CALLOUT_MAX_LEADER * 4).get(o.id)
      if (!p) continue
      gaveUp.delete(o.id)
      commit(it, p)
    }
    // A tile whose box found no place even with a long leader keeps its
    // plain name where it fits: better a name beside it than none.
    // (Rare: the row and the nearest-spot passes both failed.)
    return taken
  }
  if (wantCallouts && ours.length) {
    // The layout depends on the zoom and the plan only - never the view,
    // a hover or the cables - and costs hundreds of ms on a hall of racks:
    // a pan, a hover or a second settle at the same zoom reuses it.
    const key = JSON.stringify([
      scale,
      font,
      gap,
      input.boundsOnly ? bounds : null,
      fixedBoxes,
      tileBodies,
      bodyList,
      icons.boxes(),
      rooms,
      ours.map((o) => [o.id, o.box, o.home, o.text, lines?.get(o.id)]),
      trial.map((r) => [
        r.id,
        r.priority,
        !!r.block,
        r.spots.map((s) => s.box),
      ]),
    ])
    let hit = calloutCache.get(key)
    if (hit) {
      // Most recent last.
      calloutCache.delete(key)
      calloutCache.set(key, hit)
    } else {
      const taken = layOut()
      hit = { callouts: [...callouts], calledOut: [...calledOut], taken }
      callouts.length = 0
      calledOut.clear()
      calloutCache.set(key, hit)
      while (calloutCache.size > CALLOUT_CACHE)
        calloutCache.delete(calloutCache.keys().next().value!)
    }
    callouts.push(...hit.callouts)
    for (const id of hit.calledOut) calledOut.add(id)
    // Taken before anything else is placed: the lower ranked keep off the
    // boxes and their leaders.
    for (const b of hit.taken) occ.add(b)
  }
  // A tile named in a callout has no plain name.
  const tileReqsShown = calledOut.size
    ? tileReqs.filter((r) => !calledOut.has(r.id.slice(5)))
    : tileReqs

  // Cables: along their lanes, road names; a bundle's count along it.
  const cableText = new Map<string, { text: string; suffix?: string }>()
  const endTexts = new Map<string, string>()
  const c = input.cables
  if (c) {
    const byId = new Map(c.paths.map((cp) => [cp.id, cp]))
    for (const id of c.layout.order) {
      const cp = byId.get(id)
      const route = c.routes.get(id)
      if (!cp || !route) continue
      const focus = c.focus.has(id)
      if (!focus && (!c.names || c.focusOnly)) continue
      const suffix = c.lengths
        ? ` · ${formatMetres(routeLengthM(route, input.cellMm))}`
        : undefined
      cableText.set(id, { text: cp.label, suffix })
      const size = textSize(cp.label + (suffix ?? ""), font)
      const segs = c.layout.cables.get(id)!
      const runs = cableLegs(
        segs,
        focus ? () => false : (s) => !!s.group && c.bundled.has(s.group)
      )
      const slots = alongSlots(runs.flat(), size, {
        scale,
        repeat: input.repeat,
        view,
      }).map((spots) => along(spots))
      const base = focus
        ? RANK.focus
        : route.stored
          ? RANK.cableStored
          : RANK.cable
      slots.forEach((spots, k) =>
        reqs.push({
          id: `cable:${id}#${k}`,
          priority: base - k * 10,
          force: focus && k === 0,
          spots,
          // A name in the open, never over a rack or a device: a road
          // name does not run across the buildings beside it.
          avoid: tileBodies,
        })
      )
      // The focus's ends: the ports, outside the tile where the run
      // leaves it.
      if (focus && c.ends) {
        const ends = routeEnds(cp, route, (tid) => {
          const t = input.tiles.find((x) => x.id === tid)
          if (!t) return null
          return (
            input.shapeOf?.(t)?.box ?? {
              x: t.x,
              y: t.y,
              w: t.width,
              h: t.height,
            }
          )
        })
        ends.forEach((e, i) => {
          if (!e.rect) return
          const text = endText(e.points)
          const key = `end:${id}:${i}`
          endTexts.set(key, text)
          reqs.push({
            id: key,
            priority: RANK.focus - 1,
            force: true,
            spots: inside(
              endChipSpots(
                e,
                e.rect,
                textSize(text, input.chipFont),
                gap,
                scale
              )
            ),
          })
        })
      }
    }
    if (!c.focusOnly)
      for (const key of c.bundled) {
        const g: LaneGroup | undefined = c.layout.groups.get(key)
        if (!g) continue
        const text = `${g.members.length} cables`
        cableText.set(`bundle:${key}`, { text })
        alongSlots(
          [{ a: g.a, b: g.b, tray: key.startsWith("t:") }],
          textSize(text, font),
          { scale, repeat: input.repeat, view }
        ).forEach((spots, k) =>
          reqs.push({
            id: `bundle:${key}#${k}`,
            priority: RANK.bundle - k * 10,
            spots: along(spots),
          })
        )
      }
  }

  // Trays: the name and count along the tray, beside its channel.
  const trayText = new Map<string, string>()
  for (const tray of input.trays ?? []) {
    if (tray.points.length < 2 || !tray.name) continue
    const count = tray.cables.length
    const hidden = tray.hidden_cable_count
    const text =
      tray.name +
      (count > 0 ? ` · ${count}` : "") +
      (hidden > 0 ? ` · ${hidden} hidden` : "")
    trayText.set(tray.id, text)
    const size = textSize(text, font)
    alongSlots(polylineLegs(tray.points), size, {
      scale,
      repeat: input.repeat * 2,
      view,
      offset: (input.trayWidth ?? 0) / 2 + gap / 2 + size.h / 2,
    }).forEach((spots, k) =>
      reqs.push({
        id: `tray:${tray.id}#${k}`,
        priority: RANK.tray - k * 10,
        spots: along(spots),
        avoid: tileBodies,
        // Never over an icon: a tray's name read as a rack's.
        block: icons,
      })
    )
  }

  reqs.push(...tileReqsShown)

  // Areas: the name in its corner, else a free spot inside, off the racks.
  const areaReqs = new Map<string, "fixed" | "move">()
  for (const a of input.areas ?? []) {
    if (!a.show_name) continue
    const name = areaName(a)
    if (!name) continue
    const fpx = input.areaFontPx ?? 12
    const shift = areaIcon(a) ? fpx * 1.4 : 0
    const size = {
      w: (name.length * fpx * 0.6 + shift) * u,
      h: fpx * 1.2 * u,
    }
    if (a.shape === "polygon") {
      if (a.points.length < 3) continue
      const [cx, cy] = polygonCentroid(a.points)
      const box = {
        x: cx * scale - size.w / 2,
        y: cy * scale - size.h / 2,
        ...size,
      }
      if (!inView(box)) continue
      areaReqs.set(a.id, "fixed")
      reqs.push({
        id: `area:${a.id}`,
        priority: RANK.area,
        spots: [{ box, data: null }],
        block: icons,
      })
      continue
    }
    if (a.rotation) continue
    const rect = { x: a.x, y: a.y, w: a.width, h: a.height }
    const pad = 6 * u * (fpx / 12)
    let spots = insideSpots(rect, size, pad, scale)
    // A room narrower than its name: its top left corner, the name running
    // past the edge - shown only where it covers no icon or callout.
    if (!spots.length) {
      const x = rect.x * scale + pad
      const y = rect.y * scale + pad
      spots = [
        {
          box: { x, y, ...size },
          data: { at: [x / scale, y / scale] as Pt },
        },
      ]
    }
    if (!spots.some((s) => inView(s.box))) continue
    areaReqs.set(a.id, "move")
    reqs.push({
      id: `area:${a.id}`,
      priority: RANK.area,
      spots,
      avoid: tileBodies,
      block: icons,
    })
  }

  for (const r of input.raised ?? []) {
    const box = boxOfCells(r.box, scale)
    const tw = r.text.length * r.fontPx * 0.6 * u
    const th = r.fontPx * 1.2 * u
    // Bottom left, as the canvas draws it.
    const cap = {
      x: box.x + 6 * u,
      y: box.y + box.h - 6 * u - th,
      w: tw,
      h: th,
    }
    if (!inView(cap)) continue
    reqs.push({
      id: `raised:${r.id}`,
      priority: RANK.raised,
      spots: [{ box: cap, data: null }],
      block: icons,
    })
  }

  const placed = placeLabels(reqs, occ)

  const out: PlanLabels = {
    cables: [],
    bundles: [],
    trays: [],
    ends: [],
    tiles: [],
    tileNamesHere,
    areas: new Map(),
    hiddenRaised: new Set(),
    callouts,
    taken: occ.boxes(),
  }
  for (const [key, spot] of placed) {
    const [kind, rest] = [
      key.slice(0, key.indexOf(":")),
      key.slice(key.indexOf(":") + 1),
    ]
    const along = spot.data as AlongSpot
    if (kind === "cable" || kind === "bundle") {
      const id = rest.slice(0, rest.lastIndexOf("#"))
      const t = cableText.get(kind === "bundle" ? `bundle:${id}` : id)!
      ;(kind === "cable" ? out.cables : out.bundles).push({
        key,
        id,
        at: along.at,
        angle: along.angle,
        text: t.text,
        suffix: t.suffix,
      })
    } else if (kind === "tray") {
      const id = rest.slice(0, rest.lastIndexOf("#"))
      out.trays.push({
        key,
        id,
        at: along.at,
        angle: along.angle,
        text: trayText.get(id)!,
      })
    } else if (kind === "end") {
      out.ends.push({
        key,
        id: rest.slice(0, rest.indexOf(":")),
        at: (spot.data as { at: Pt }).at,
        text: endTexts.get(key)!,
      })
    } else if (kind === "tile") {
      out.tiles.push({
        key,
        id: rest,
        at: (spot.data as { at: Pt }).at,
        text: tileText.get(rest)!,
      })
    } else if (kind === "area" && areaReqs.get(rest) === "move") {
      out.areas.set(rest, (spot.data as { at: Pt }).at)
    }
  }
  // A zone's name that gave way: drawn by no one.
  for (const id of zoneNames)
    if (!placed.has(`tilefix:${id}`)) tileNamesHere.add(id)
  for (const [id] of areaReqs)
    if (!placed.has(`area:${id}`)) out.areas.set(id, null)
  for (const r of input.raised ?? [])
    if (
      !placed.has(`raised:${r.id}`) &&
      reqs.some((q) => q.id === `raised:${r.id}`)
    )
      out.hiddenRaised.add(r.id)
  return out
}

export type { LabelSpot }
