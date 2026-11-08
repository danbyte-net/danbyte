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
  boxesHit,
  turnedBox,
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
  CalloutBoard,
  MAX_CROWD_CALLOUTS,
  NEAR_LEADER_PLATES,
  calloutClusters,
  calloutSize,
  leaderBoxes,
  nearSpots,
  unionBox,
} from "./plan-callouts"
import type { CalloutItem, CalloutLine, CalloutSide } from "./plan-callouts"
import { clusterNameOf } from "./icon-layout"
import { findRows, rowAngle, rowName } from "./plan-rows"
import type { RowTile } from "./plan-rows"
import { wallOf } from "./plan-lod"
import type { PlanRoom } from "./plan-lod"
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
  /** The room a point (cells) is in (plan-lod.ts): callouts crowd and
   * sum up room by room, wall by wall. */
  roomOf?: (p: Pt) => PlanRoom | null
  /** A zone's name grown by this much (Readable from afar). */
  zoneGrow?: number
  /** Tile names scaled to fill their tile (Display > Fit labels). */
  labelFit?: boolean
  /** The turn a tile is drawn with about its centre (degrees; a free
   * plan's tiles): rows run along it. 0 when absent. */
  angleOf?: (t: FloorPlanTile) => number
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
  /** Callouts (the canvas, Display > Callouts: Auto): a name that does
   * not fit in its tile is named once along its row, or in a box set off
   * beside it with a short leader back to it, its `lines` under the name -
   * never as loose text by the tile. */
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
  /** A summary plate: the tiles of the crowd it names. */
  members?: readonly string[]
}

/** A row named along it: its text's centre (cells), its angle (upright),
 * its plate's size (units) and the tiles it names. */
export interface RowLabel {
  id: string
  text: string
  at: Pt
  angle: number
  size: { w: number; h: number }
  members: readonly string[]
}

/** A cluster tile, for the label pass. */
export interface IconClusterLabel {
  id: string
  box: Box
  name: string
  members: readonly string[]
  /** A row drawn as one bar (plan-lod.ts): its line and thickness
   * (cells), named along it - its full name, else its short one. */
  row?: {
    centre: Pt
    dir: Pt
    length: number
    thick: number
    text: string
    short: string
  }
  /** A room's summary (plan-lod.ts): it names itself, and its room (this
   * area id) - whose own name it says, so that is not drawn. */
  hall?: string
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
  /** Rows named along them (their tiles' names not drawn). */
  rows: RowLabel[]
  /** Every box taken (units), for a caller laying out more. */
  taken: readonly Box[]
}

const boxOfCells = (b: Box, scale: number): Box => ({
  x: b.x * scale,
  y: b.y * scale,
  w: b.w * scale,
  h: b.h * scale,
})

/** What a cluster covers (units): a row bar as boxes along it, so its
 * upright bounds do not claim the aisles round a turned row. */
function clusterBodies(c: IconClusterLabel, scale: number): Box[] {
  if (!c.row) return [boxOfCells(c.box, scale)]
  return alongBoxes(
    [c.row.centre[0] * scale, c.row.centre[1] * scale],
    rowAngle(c.row.dir),
    { w: c.row.length * scale, h: c.row.thick * scale }
  )
}

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

/** Does a tile's name read whole in its tile at `u` units per plan px -
 * as TileShape draws it, untrimmed and big enough to read? */
export function nameFitsTile(
  t: Pick<FloorPlanTile, "width" | "height">,
  name: string,
  labelFit: boolean,
  u: number
): boolean {
  const w = t.width * CELL
  const h = t.height * CELL
  if (labelFit) {
    const font = Math.max(
      5,
      Math.min(h * 0.55, (w - 8) / (Math.max(1, name.length) * 0.62))
    )
    return (
      font * u >= MIN_IN_TILE_NAME_PX &&
      name.length * font * 0.62 <= w - 8 + 0.5
    )
  }
  return (
    11 * u >= MIN_IN_TILE_NAME_PX &&
    name.length <= Math.max(3, Math.floor(w / 7))
  )
}

/** A text turned by `angle` about `at` (units) as small upright boxes
 * along it, about as long as it is tall: its bounds would claim a wide
 * square of the plan round a slanted name. */
export function alongBoxes(
  at: Pt,
  angle: number,
  size: { w: number; h: number }
): Box[] {
  const r = (angle * Math.PI) / 180
  const d: Pt = [Math.cos(r), Math.sin(r)]
  const n = Math.max(1, Math.ceil(size.w / size.h))
  const step = size.w / n
  const out: Box[] = []
  for (let i = 0; i < n; i++) {
    const s = -size.w / 2 + step * (i + 0.5)
    out.push(turnedBox(at[0] + d[0] * s, at[1] + d[1] * s, step, size.h, angle))
  }
  return out
}

/** Where a turned area draws its name (shape-layer.tsx: its top left,
 * turned with the area), as boxes along it (units). */
function turnedAreaName(
  a: AreaShape,
  name: string,
  fontPx: number,
  scale: number,
  u: number
): Box[] {
  const g = fontPx / 12
  const w = name.length * fontPx * 0.6 + (areaIcon(a) ? fontPx * 1.4 : 0)
  const h = fontPx * 1.2
  // Its middle before the turn (plan px), then turned about the area's.
  const mx = a.x * CELL + 6 * g + w / 2
  const my = a.y * CELL + 15 * g - h * 0.35
  const cx = (a.x + a.width / 2) * CELL
  const cy = (a.y + a.height / 2) * CELL
  const r = (a.rotation * Math.PI) / 180
  const px = cx + (mx - cx) * Math.cos(r) - (my - cy) * Math.sin(r)
  const py = cy + (mx - cx) * Math.sin(r) + (my - cy) * Math.cos(r)
  const k = scale / CELL
  return alongBoxes([px * k, py * k], a.rotation, { w: w * u, h: h * u })
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
  {
    callouts: CalloutLabel[]
    rows: RowLabel[]
    calledOut: string[]
    taken: Box[]
  }
>()

/** A name's stem: past its trailing number and separators ("CRAH-DH1-04"
 * → "CRAH-DH1", "UPS-A1" → "UPS-A"). */
export function nameStem(name: string): string {
  return name.replace(/\d+$/, "").replace(/[\s\-_./·]+$/, "")
}

/** The stem `names` share, or "" when they share none worth saying. */
export function sharedStem(names: readonly string[]): string {
  if (!names.length) return ""
  const stems = names.map(nameStem)
  return stems.every((s) => s === stems[0]) && stems[0].length >= 2
    ? stems[0]
    : ""
}

/** A crowd within this many leader reaches reads as one; a bigger one's
 * leftovers are summed up by regions this size. */
const REGION_PLATES = 4

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
  const clusterBoxes = new Map(
    (input.iconClusters ?? []).map((c) => [c.id, clusterBodies(c, scale)])
  )
  for (const bs of clusterBoxes.values()) for (const b of bs) icons.add(b)
  // A room summed up names itself: its area's own name gives way.
  const hallAreas = new Set(
    (input.iconClusters ?? []).flatMap((c) => (c.hall ? [c.hall] : []))
  )
  for (const t of input.tiles) {
    if (!input.iconIds?.has(t.id) || clustered.has(t.id)) continue
    const box = input.shapeOf?.(t)?.box
    if (box) icons.add(boxOfCells(box, scale))
  }
  // Callouts (Auto): a name that does not fit in its tile is never loose
  // text by it - its row's name says it, or a box beside it.
  const wantCallouts = !!input.callouts
  const named = RANK.tile
  /** A name of ours under Auto: its drawn box (units), its row geometry
   * (a tile drawn at its own place), its rank among the crowds. */
  const ours: {
    id: string
    box: Box
    text: string
    kind: string
    rank: number
    grow: number
    row: RowTile | null
    members?: readonly string[]
  }[] = []
  const bodies = new BoxIndex(Math.max(16, font * 6))
  // What `bodies` holds, for the callouts' cache key.
  const bodyList: [string, Box][] = []
  const addBody = (id: string, b: Box) => {
    bodies.add(id, b)
    bodyList.push([id, b])
  }
  for (const [id, bs] of clusterBoxes) for (const b of bs) addBody(id, b)
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
    // Callouts on: a name that does not read whole in its tile at this
    // zoom - too small, or cut short - is named outside it instead.
    const outside =
      wantCallouts && !zone && !nameFitsTile(t, name, !!input.labelFit, u)
    const ours_ =
      outside ||
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
    if (wantCallouts) {
      const kind = t.linked?.kind ?? ""
      ours.push({
        id: t.id,
        box: boxOfCells(drawn, scale),
        text,
        kind,
        // Infrastructure (a cooling unit, a UPS) first, then racks, then
        // devices.
        rank:
          kind === "rack" || kind === "cabinet" ? 2 : kind === "device" ? 1 : 3,
        grow: shape?.changed ? shape.grow : 1,
        // An icon is drawn off its place: no row of its own.
        row: icon
          ? null
          : {
              id: t.id,
              x: t.x,
              y: t.y,
              w: t.width,
              h: t.height,
              angle: input.angleOf?.(t) ?? 0,
              kind: kind || (t.tile_type?.id ?? t.role_type?.id ?? ""),
              name,
            },
      })
      continue
    }
    const all = (icon ? aroundSpots : besideSpots)(
      drawn,
      textSize(text, font),
      gap / 2,
      scale
    )
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
    // A row bar is named along it, a room's summary by itself.
    if (c.row || c.hall) continue
    const text = clipName(c.name)
    tileText.set(c.id, text)
    if (wantCallouts) {
      ours.push({
        id: c.id,
        box: boxOfCells(c.box, scale),
        text,
        kind: "cluster",
        rank: 2,
        grow: 1,
        row: null,
        members: c.members,
      })
      continue
    }
    const all = aroundSpots(c.box, textSize(text, font), gap / 2, scale)
    // Over a single rack's name: it stands for several.
    const priority = named + 1000 + Math.min(999, c.members.length)
    const spots = inside(all)
    if (!spots.some((s) => inView(s.box))) continue
    tileReqs.push({ id: `tile:${c.id}`, priority, spots, block: icons })
  }
  // The rooms' names keep their place: a turned area's name is drawn
  // where it is (shape-layer.tsx), an upright one's first spot is its top
  // left corner - rows and callouts keep off both.
  const areaFont = input.areaFontPx ?? 12
  const roomNames: Box[] = []
  if (wantCallouts)
    for (const a of input.areas ?? []) {
      if (!a.show_name || a.shape === "polygon" || hallAreas.has(a.id)) continue
      const name = areaName(a)
      if (!name) continue
      if (a.rotation) {
        const boxes = turnedAreaName(a, name, areaFont, scale, u)
        roomNames.push(...boxes)
        for (const bx of boxes) occ.add(bx)
      } else {
        const shift = areaIcon(a) ? areaFont * 1.4 : 0
        const pad = 6 * u * (areaFont / 12)
        roomNames.push({
          x: a.x * scale + pad,
          y: a.y * scale + pad,
          w: (name.length * areaFont * 0.6 + shift) * u,
          h: areaFont * 1.2 * u,
        })
      }
    }

  // Under Auto: rows named along them, then a box per name for the rest,
  // crowd by crowd. Decided over the whole plan, not the view, so a pan
  // never moves one.
  const callouts: CalloutLabel[] = []
  const rowLabels: RowLabel[] = []
  const calledOut = new Set<string>()
  const lines = input.callouts?.lines
  const linesOf = (id: string) =>
    (lines?.get(id) ?? []).slice(0, CALLOUT_MAX_LINES)
  // Fills `callouts`, `rowLabels` and `calledOut`; returns the boxes taken
  // (the boxes, their leaders, the rows' names).
  const layOut = (): Box[] => {
    const cell = Math.max(16, font * 6)
    const join = READABLE_SYMBOL_PX * 1.5
    const toCells = (p: Pt): Pt => [p[0] / scale, p[1] / scale]
    const taken: Box[] = []
    // Clear of every tile, icon and fixed text.
    const solid = new Occupancy(cell)
    // The fixed text alone: a row's name may run over an aisle's tiles.
    const text = new Occupancy(cell)
    for (const b of [...fixedBoxes, ...roomNames]) {
      solid.add(b)
      text.add(b)
    }
    for (const b of tileBodies) solid.add(b)
    for (const bs of clusterBoxes.values()) for (const b of bs) solid.add(b)
    const within = (b: Box) =>
      !input.boundsOnly || !bounds || contains(bounds, b)

    // Rows: one name along each, beside it on either side, else over it.
    const inRow = new Set<string>()
    const oursById = new Map(ours.map((o) => [o.id, o]))
    // The rows of tiles drawn, and the rows drawn as one bar from afar
    // (plan-lod.ts): one name each, the longest first.
    const toName = [
      ...findRows(ours.flatMap((o) => (o.row ? [o.row] : []))).map((r) => {
        const nm = rowName(r.names)
        const grow = Math.max(...r.members.map((id) => oursById.get(id)!.grow))
        return {
          id: r.id,
          text: nm.text,
          short: nm.short,
          // A tile row's name may run a little past its ends.
          slack: 2,
          centre: r.centre,
          dir: r.dir,
          length: r.length,
          depth: r.depth * grow,
          own: new Set(r.members),
          members: r.members,
        }
      }),
      ...(input.iconClusters ?? []).flatMap((c) =>
        c.row
          ? [
              {
                id: c.id,
                text: c.row.text,
                short: c.row.short,
                slack: 0,
                centre: c.row.centre,
                dir: c.row.dir,
                length: c.row.length,
                depth: c.row.thick,
                own: new Set([c.id, ...c.members]),
                members: c.members,
              },
            ]
          : []
      ),
    ]
    toName.sort((a, b) => b.length - a.length || (a.id < b.id ? -1 : 1))
    for (const r of toName) {
      if (!r.text) continue
      const lenPx = r.length * scale
      let label = r.text
      let size = textSize(label, font)
      if (size.w > lenPx + size.h * r.slack && r.short && r.short !== r.text) {
        label = r.short
        size = textSize(label, font)
      }
      const angle = rowAngle(r.dir)
      const nrm: Pt = [-r.dir[1], r.dir[0]]
      const off = (r.depth * scale) / 2 + gap / 2 + size.h / 2
      const range = Math.max(0, (lenPx - size.w) / 2)
      const own = r.own
      const c0: Pt = [r.centre[0] * scale, r.centre[1] * scale]
      let pick: { at: Pt; boxes: Box[] } | null = null
      for (const side of [off, -off, 0])
        for (const f of side ? [0, -0.5, 0.5, -1, 1] : [0]) {
          if (pick) break
          const s = f * range
          if (f && !range) continue
          const at: Pt = [
            c0[0] + r.dir[0] * s + nrm[0] * side,
            c0[1] + r.dir[1] * s + nrm[1] * side,
          ]
          const boxes = alongBoxes(at, angle, size)
          if (
            boxes.every(
              (bx) =>
                within(bx) &&
                text.free(bx) &&
                !bodies.some(bx, (o) => !own.has(o.id) && boxesHit(o.box, bx))
            )
          )
            pick = { at, boxes }
        }
      if (!pick) continue
      for (const bx of pick.boxes) {
        text.add(bx)
        solid.add(bx)
        taken.push(bx)
      }
      for (const id of r.members) {
        inRow.add(id)
        calledOut.add(id)
      }
      inRow.add(r.id)
      rowLabels.push({
        id: r.id,
        text: label,
        at: toCells(pick.at),
        angle,
        size,
        members: r.members,
      })
    }

    // The rest in callouts, crowd by crowd: a crowd of a few in one stack
    // beside it; a bigger one split into its tighter crowds, each stacked
    // the same way; what still finds no room named by one summary plate.
    type Ours = (typeof ours)[number]
    const rest = ours.filter((o) => !inRow.has(o.id))
    // The crowd as a whole, then its huddles: things nearer than this
    // stay one crowd however big, so a dense knot is summarised, not
    // boxed name by name.
    const joins = [join, join / 3]
    const crowdsOf = (list: readonly Ours[], j: number): Ours[][] => {
      const clusterOf = calloutClusters(list, j)
      const crowds = new Map<number, Ours[]>()
      for (const o of list) {
        const k = clusterOf.get(o.id)!
        const l = crowds.get(k)
        if (l) l.push(o)
        else crowds.set(k, [o])
      }
      return [...crowds.values()].sort(crowdOrder)
    }
    // Infrastructure first, then the smaller crowds.
    const crowdOrder = (a: readonly Ours[], b: readonly Ours[]) =>
      Math.max(...b.map((o) => o.rank)) - Math.max(...a.map((o) => o.rank)) ||
      a.length - b.length ||
      (a[0].id < b[0].id ? -1 : 1)
    const centreOf = (o: Ours): Pt => [
      (o.box.x + o.box.w / 2) / scale,
      (o.box.y + o.box.h / 2) / scale,
    ]
    const roomOf = (o: Ours) => input.roomOf?.(centreOf(o)) ?? null
    const board = new CalloutBoard({
      free: (bx) => solid.free(bx),
      bounds: input.boundsOnly ? bounds : null,
      bodies,
    })
    const reach = NEAR_LEADER_PLATES * calloutSize("", []).h
    /** A crowd no wider or taller than this many reaches reads as one. */
    const small = (list: readonly Ours[]) => {
      const b = unionBox(list.map((o) => o.box))
      return b.w <= REGION_PLATES * reach && b.h <= REGION_PLATES * reach
    }
    const commit = (
      id: string,
      name: string,
      p: { box: Box; side: CalloutSide; leader: [Pt, Pt] },
      members?: readonly string[]
    ) => {
      taken.push(p.box, ...leaderBoxes(p.leader))
      callouts.push({
        id,
        name,
        lines: members ? [] : linesOf(id),
        at: toCells([p.box.x + p.box.w / 2, p.box.y + p.box.h / 2]),
        size: { w: p.box.w, h: p.box.h },
        side: p.side,
        leader: [toCells(p.leader[0]), toCells(p.leader[1])],
        ...(members ? { members } : {}),
      })
    }
    const itemOf = (o: Ours): CalloutItem => ({
      id: o.id,
      anchor: o.box,
      size: calloutSize(o.text, linesOf(o.id)),
      group: "crowd",
      container: o.box,
    })
    // Places what it can of a crowd; returns what found no place.
    const place = (crowd: readonly Ours[], level: number): Ours[] => {
      if (crowd.length === 1) {
        const p = board.near(itemOf(crowd[0]), reach)
        if (!p) return [...crowd]
        calledOut.add(crowd[0].id)
        commit(crowd[0].id, crowd[0].text, p, crowd[0].members)
        return []
      }
      if (crowd.length <= MAX_CROWD_CALLOUTS) {
        const placed = board.stack(crowd.map(itemOf), reach)
        if (placed) {
          for (const o of crowd) {
            calledOut.add(o.id)
            commit(o.id, o.text, placed.get(o.id)!, o.members)
          }
          return []
        }
      }
      // Its tighter crowds, each on its own.
      for (let l = level + 1; l < joins.length; l++) {
        const parts = crowdsOf(crowd, joins[l])
        if (parts.length > 1) return parts.flatMap((part) => place(part, l))
      }
      // A tight knot: one plate says it.
      if (crowd.length <= MAX_CROWD_CALLOUTS || small(crowd)) return [...crowd]
      // A building's worth, all touching: each where it has room close
      // by, infrastructure first; the rest in plates by region.
      const left: Ours[] = []
      for (const o of [...crowd].sort(
        (a, b) => b.rank - a.rank || (a.id < b.id ? -1 : 1)
      )) {
        const p = board.near(itemOf(o), reach)
        if (!p) {
          left.push(o)
          continue
        }
        calledOut.add(o.id)
        commit(o.id, o.text, p, o.members)
      }
      return left
    }
    // What found no place, in one plate per room wall and kind ("CRAH ×
    // 6"), else per region: a short leader to it, or over them when there
    // is no room beside - never a name lost without a word, never a plate
    // across the plan.
    const kindOf = new Map(input.tiles.map((t) => [t.id, t.linked?.kind ?? ""]))
    const summarise = (left: readonly Ours[]) => {
      const regions = new Map<string, Ours[]>()
      const size = REGION_PLATES * reach
      for (const o of left) {
        const room = roomOf(o)
        const k = room
          ? `${room.id}:${wallOf(room, centreOf(o))}:${o.members ? "" : nameStem(o.text)}`
          : small(left)
            ? "all"
            : `${Math.floor((o.box.x + o.box.w / 2) / size)},${Math.floor((o.box.y + o.box.h / 2) / size)}`
        const l = regions.get(k)
        if (l) l.push(o)
        else regions.set(k, [o])
      }
      for (const part of regions.values()) {
        const ids = part.map((o) => o.id).sort()
        // One alone - a tile, or a cluster - by its own name.
        const one = part.length === 1
        // On its wall of a room, by what they are: "CRAH-DH1 ×6".
        const stem =
          roomOf(part[0]) && part.every((o) => !o.members)
            ? sharedStem(part.map((o) => o.text))
            : ""
        const name = one
          ? part[0].text
          : stem
            ? `${stem} ×${part.length}`
            : clusterNameOf(
                part.flatMap((o) =>
                  o.members
                    ? o.members.map((id) => ({
                        name: "",
                        kind: kindOf.get(id) ?? "",
                      }))
                    : [{ name: o.text, kind: o.kind }]
                )
              )
        const box = unionBox(part.map((o) => o.box))
        const it: CalloutItem = one
          ? itemOf(part[0])
          : {
              id: `crowd:${ids[0]}`,
              anchor: box,
              size: calloutSize(name, []),
              group: "crowd",
              container: box,
            }
        const own = new Set([...ids, ...part.flatMap((o) => o.members ?? [])])
        const p = board.near(it, reach * 2, own) ?? board.over(it, own)
        if (!p) continue
        for (const id of ids) calledOut.add(id)
        commit(
          it.id,
          name,
          p,
          one ? part[0].members : part.flatMap((o) => o.members ?? [o.id])
        )
      }
    }
    // Crowds room by room: a callout's crowd never spans two rooms.
    const byRoom = new Map<string, Ours[]>()
    for (const o of rest) {
      const k = roomOf(o)?.id ?? ""
      const l = byRoom.get(k)
      if (l) l.push(o)
      else byRoom.set(k, [o])
    }
    const crowds = [...byRoom.values()]
      .flatMap((list) => crowdsOf(list, joins[0]))
      .sort(crowdOrder)
    for (const crowd of crowds) {
      const left = place(crowd, 0)
      if (left.length) summarise(left)
    }
    return taken
  }
  const barRows = (input.iconClusters ?? []).filter((c) => c.row)
  if ((wantCallouts && ours.length) || barRows.length) {
    // The layout depends on the zoom and the plan only - never the view,
    // a hover or the cables - and can cost a lot on a hall of racks: a
    // pan, a hover or a second settle at the same zoom reuses it.
    const key = JSON.stringify([
      scale,
      font,
      gap,
      input.boundsOnly ? bounds : null,
      fixedBoxes,
      roomNames,
      tileBodies,
      bodyList,
      ours.map((o) => [
        o.id,
        o.box,
        o.text,
        o.kind,
        o.grow,
        o.row,
        o.members,
        lines?.get(o.id),
      ]),
      barRows.map((c) => [c.id, c.row, c.members.length]),
    ])
    let hit = calloutCache.get(key)
    if (hit) {
      // Most recent last.
      calloutCache.delete(key)
      calloutCache.set(key, hit)
    } else {
      const taken = layOut()
      hit = {
        callouts: [...callouts],
        rows: [...rowLabels],
        calledOut: [...calledOut],
        taken,
      }
      callouts.length = 0
      rowLabels.length = 0
      calledOut.clear()
      calloutCache.set(key, hit)
      while (calloutCache.size > CALLOUT_CACHE)
        calloutCache.delete(calloutCache.keys().next().value!)
    }
    callouts.push(...hit.callouts)
    rowLabels.push(...hit.rows)
    for (const id of hit.calledOut) calledOut.add(id)
    // Taken before anything else is placed: the lower ranked keep off the
    // boxes, their leaders and the rows' names.
    for (const b of hit.taken) occ.add(b)
    // The selected or hovered named by its row (or by no one): its own box
    // too, beside it, for as long as it is pinned.
    const shown = new Set(callouts.map((c) => c.id))
    for (const id of input.pinnedTiles ?? []) {
      const o = ours.find((x) => x.id === id)
      if (!o || shown.has(id) || o.members) continue
      const it: CalloutItem = {
        id,
        anchor: o.box,
        size: calloutSize(o.text, linesOf(id)),
        group: "pinned",
        container: o.box,
      }
      const reach = NEAR_LEADER_PLATES * calloutSize("", []).h
      const spots = nearSpots(it, reach * 2)
      const fits = (s: (typeof spots)[number]) =>
        occ.free(s.box) && leaderBoxes(s.leader).every((bx) => occ.free(bx))
      const s = spots.find(fits) ?? spots.at(0)
      if (!s) continue
      occ.add(s.box)
      callouts.push({
        id,
        name: o.text,
        lines: linesOf(id),
        at: [(s.box.x + s.box.w / 2) / scale, (s.box.y + s.box.h / 2) / scale],
        size: { w: s.box.w, h: s.box.h },
        side: s.side,
        leader: [
          [s.leader[0][0] / scale, s.leader[0][1] / scale],
          [s.leader[1][0] / scale, s.leader[1][1] / scale],
        ],
      })
    }
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
  const hiddenAreas: string[] = []
  for (const a of input.areas ?? []) {
    if (!a.show_name) continue
    const name = areaName(a)
    if (!name) continue
    // Its rows summed up on it: the summary says its name.
    if (hallAreas.has(a.id)) {
      hiddenAreas.push(a.id)
      continue
    }
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
    rows: rowLabels,
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
  for (const id of hiddenAreas) out.areas.set(id, null)
  for (const r of input.raised ?? [])
    if (
      !placed.has(`raised:${r.id}`) &&
      reqs.some((q) => q.id === `raised:${r.id}`)
    )
      out.hiddenRaised.add(r.id)
  return out
}

export type { LabelSpot }
