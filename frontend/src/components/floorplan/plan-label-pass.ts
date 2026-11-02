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
import { clipName, namePriority } from "./readable"
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

/** The pass: plan labels, then the cables (the focus first), the tiles'
 * fixed names, the trays, the tiles' movable names, the areas, the raised
 * floors - each at its first free place, or hidden. */
export function layoutPlanLabels(input: PlanLabelInput): PlanLabels {
  const { scale, unitsPerPx: u, font, gap, view } = input
  const occ = new Occupancy(Math.max(16, font * 6))
  const reqs: LabelRequest<unknown>[] = []
  const inView = (b: Box) =>
    !view ||
    (b.x < view.x + view.w &&
      b.x + b.w > view.x &&
      b.y < view.y + view.h &&
      b.y + b.h > view.y)

  // Plan labels: never hidden - there first.
  for (const l of input.planLabels ?? []) {
    const b = shapeBounds(l, input.cellMm)
    const box = boxOfCells(
      { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
      scale
    )
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
    if (!name) continue
    const ours =
      !!shape &&
      !zone &&
      (shape.changed || (t.display === "photo" && !!t.photo))
    if (!ours) {
      const b = inTileNameBox(t, name, !!input.labelFit, input.zoneGrow)
      const box = { x: b.x * u, y: b.y * u, w: b.w * u, h: b.h * u }
      if (!inView(box)) continue
      reqs.push({
        id: `tilefix:${t.id}`,
        priority: RANK.tileFixed,
        force: true,
        spots: [{ box, data: null }],
      })
      continue
    }
    tileNamesHere.add(t.id)
    const text = clipName(name)
    tileText.set(t.id, text)
    const icon = !!input.iconIds?.has(t.id)
    const spots = (icon ? aroundSpots : besideSpots)(
      drawn,
      textSize(text, font),
      gap / 2,
      scale
    )
    if (!spots.some((s) => inView(s.box))) continue
    const pinned = !!input.pinnedTiles?.has(t.id)
    tileReqs.push({
      id: `tile:${t.id}`,
      priority: pinned ? RANK.tilePinned : RANK.tile + namePriority(t),
      force: pinned,
      spots,
      block: icon ? icons : undefined,
    })
  }
  for (const c of input.iconClusters ?? []) {
    const text = clipName(c.name)
    tileText.set(c.id, text)
    const spots = aroundSpots(c.box, textSize(text, font), gap / 2, scale)
    if (!spots.some((s) => inView(s.box))) continue
    tileReqs.push({
      id: `tile:${c.id}`,
      // Over a single rack's name: it stands for several.
      priority: RANK.tile + 1000 + Math.min(999, c.members.length),
      spots,
      block: icons,
    })
  }

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
      })
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
            spots: endChipSpots(
              e,
              e.rect,
              textSize(text, input.chipFont),
              gap,
              scale
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
            spots,
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
        spots,
        avoid: tileBodies,
      })
    )
  }

  reqs.push(...tileReqs)

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
      })
      continue
    }
    if (a.rotation) continue
    const rect = { x: a.x, y: a.y, w: a.width, h: a.height }
    const spots = insideSpots(rect, size, 6 * u * (fpx / 12), scale)
    if (!spots.length || !spots.some((s) => inView(s.box))) continue
    areaReqs.set(a.id, "move")
    reqs.push({
      id: `area:${a.id}`,
      priority: RANK.area,
      spots,
      avoid: tileBodies,
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
