import {
  AREA_INK_SHARE,
  PAGE_DARK,
  PAGE_LIGHT,
  areaColor,
  areaIcon,
  areaLabelColor,
  areaName,
  areaNameHalo,
  areaNameHaloColor,
  boxCenter,
  boxCorners,
  labelBox,
  labelFontCells,
  labelPlate,
  mixHex,
  polygonCentroid,
  rotatePoint,
} from "@/components/floorplan/shapes"
import type { AreaShape, LabelShape, Pt } from "@/components/floorplan/shapes"
import { tilePose } from "@/components/floorplan/tile-pose"
import { CELL } from "@/components/floorplan/canvas-geometry"
import {
  READABLE_FONT_PX,
  clipName,
  thinNames,
} from "@/components/floorplan/readable"
import type { NameCandidate } from "@/components/floorplan/readable"

import { mainAxis, readableAngle } from "./plan-text-fit"
import { trayElevationM } from "./world"
import type {
  SceneRaisedFloor,
  ScenePayload,
  SceneTile,
  SceneTray,
} from "./world"

// The plan's own text in the 3D room: the labels placed on it, its rooms'
// and areas' names, its zones' names and its trays' names - what the 2D
// plan writes, drawn on each level's floor. Labels, area and zone names
// lie flat on the floor like painted floor text, at their 2D size and
// place and turned with their object; seen from low down, where flat text
// no longer reads, each stands up as a billboard instead. A tray's name is
// a small plate over its run. Every one takes part in the room's one
// collision pass with the Readable name plates (name-layout.ts): the
// selected and hovered plates first, then the labels, then the other
// plates, the trays', the zones' and last the areas' names.

/** What a piece of plan text is. */
export type PlanTextKind = "label" | "area" | "zone" | "tray"

/** Higher wins a clash; the Readable plates rank 0 to 1e6 (a pinned one
 * is Infinity), so labels sit over them and the rest under them. */
export const PLAN_TEXT_RANK: Record<PlanTextKind, number> = {
  label: 1e7,
  tray: -1e7,
  zone: -2e7,
  area: -3e7,
}

/** The ink a piece of text is drawn in. */
export interface PlanTextInk {
  color: string
  /** A halo round the glyphs so they keep their edges over the floor. */
  halo: string | null
  haloAlpha: number
  /** A plate behind the text, and its hairline. */
  plate: string | null
  plateBorder: string | null
}

/** One piece of plan text, in the level's plan cells. */
export interface PlanTextItem {
  id: string
  kind: PlanTextKind
  lines: string[]
  /** One line's text height (cells). */
  fontCells: number
  weight: 400 | 500 | 600 | 700
  align: "left" | "center" | "right"
  /** Where it sits on the plan (cells): the quad's `pivot` point - (0, 0)
   * its top left, (0.5, 0.5) its middle - in the quad's own turned frame. */
  at: Pt
  pivot: [number, number]
  /** Degrees, clockwise on the plan. */
  rotation: number
  /** A label's own box (cells): its plate is never smaller. */
  minBox?: { w: number; h: number }
  /** Its height over the level's floor (m). */
  elevation: number
  ink: PlanTextInk
  /** A Lucide icon before the text (an area's type). */
  icon?: string
  /** The floor it names (an area's or a zone's outline, cells): the text
   * stays inside it, clear of its edges and the level's walls
   * (plan-text-fit.ts). */
  room?: {
    outline: Pt[]
    /** The turns it may take besides its own, where that holds it. */
    angles: number[]
  }
}

/** What the plan writes, as the Display menu asks for it. */
export interface PlanTextShow {
  labels: boolean
  areaNames: boolean
  zoneNames: boolean
  /** Display > Object size: Readable - names always on their halo, and a
   * room too small for its name still names it. */
  readable?: boolean
}

/** Flat text's height over the floor: over the raised floors' tops. */
export const FLOOR_TEXT_Y = 0.025

/** The theme's page and ink (the 2D plan's `--background` and
 * `--foreground`). */
export function pageInk(dark: boolean): {
  page: string
  ink: string
  border: string
} {
  return dark
    ? { page: PAGE_DARK, ink: "#fafafa", border: "#3f3f46" }
    : { page: PAGE_LIGHT, ink: "#18181b", border: "#d4d4d8" }
}

/** A label colour token as the screen draws it in each theme - the 2D
 * classes (`fill-red-600 dark:fill-red-400`, …) as hex. */
const LABEL_INK: Record<string, [string, string]> = {
  "": ["#18181b", "#fafafa"],
  muted: ["#71717a", "#a1a1aa"],
  red: ["#dc2626", "#f87171"],
  amber: ["#d97706", "#fbbf24"],
  green: ["#16a34a", "#4ade80"],
  blue: ["#2563eb", "#60a5fa"],
  violet: ["#7c3aed", "#a78bfa"],
}

/** A label's ink in the room: its token's colour for the theme, or the
 * ink that reads over its plate's fill. */
export function labelInk3D(
  l: Pick<LabelShape, "color" | "plate"> &
    Partial<Pick<LabelShape, "plate_color">>,
  dark: boolean
): PlanTextInk {
  const { page, border } = pageInk(dark)
  const plate = labelPlate(l)
  const token = (LABEL_INK[l.color] ?? LABEL_INK[""])[dark ? 1 : 0]
  return {
    color: plate.ink ?? token,
    // No plate: a halo of the page, so the text reads over the floor.
    halo: l.plate ? null : page,
    haloAlpha: 0.7,
    plate: l.plate ? (plate.fill ?? page) : null,
    plateBorder: l.plate ? (plate.fill ? null : border) : null,
  }
}

/** An area's name ink in the room - the 2D rule (shapes.ts): its own
 * colour, part page ink, over a light fill; black or white over a strong
 * one, on a halo of the other where the fill is light. Readable keeps
 * every name on its halo, as the 2D plan's grown names are. */
export function areaInk3D(
  a: AreaShape,
  dark: boolean,
  readable = false
): PlanTextInk {
  const { page, ink: fg } = pageInk(dark)
  const ink = areaLabelColor(a, page)
  const own = ink === areaColor(a)
  const hex = /^#[0-9a-f]{6}$/i.test(ink)
  const halo = areaNameHalo(a) || readable
  return {
    color: own && hex ? mixHex(ink, fg, AREA_INK_SHARE) : ink,
    halo: halo ? (own ? page : areaNameHaloColor(ink)) : null,
    haloAlpha: own ? 0.9 : 0.75,
    plate: null,
    plateBorder: null,
  }
}

/** 2D plan px (CELL to a cell) as cells. */
const cells = (px: number) => px / CELL

/** An area's name on the 2D plan: 12 px, its top left 6 px in from the
 * rectangle's corner (the baseline at 15 px) - a polygon's centred on its
 * middle. */
const AREA_NAME_PX = 12
const AREA_NAME_LEFT_PX = 6
const AREA_NAME_TOP_PX = 15 - AREA_NAME_PX * 0.8
/** A zone's name: 10 px, its top left (6, 14 - its cap height) in. */
const ZONE_NAME_PX = 10
const ZONE_NAME_LEFT_PX = 6
const ZONE_NAME_TOP_PX = 14 - ZONE_NAME_PX * 0.8
/** The share of the font a flat text's quad keeps round its glyphs. */
export const FLAT_PAD_EM = 0.25

/** An area's name as the room writes it, or null where 2D draws none. */
export function areaText(
  a: AreaShape,
  dark: boolean,
  readable = false
): PlanTextItem | null {
  if (!a.show_name) return null
  const name = areaName(a)
  if (!name) return null
  const base = {
    id: `area:${a.id}`,
    kind: "area" as const,
    lines: [name],
    fontCells: cells(AREA_NAME_PX),
    weight: 600 as const,
    align: "left" as const,
    elevation: FLOOR_TEXT_Y,
    ink: areaInk3D(a, dark, readable),
    icon: areaIcon(a) || undefined,
  }
  const pad = cells(AREA_NAME_PX) * FLAT_PAD_EM
  if (a.shape === "polygon") {
    if (a.points.length < 3) return null
    return {
      ...base,
      at: polygonCentroid(a.points),
      pivot: [0.5, 0.5],
      rotation: 0,
      room: { outline: a.points, angles: [mainAxis(a.points)] },
    }
  }
  // As 2D: a room too small for its name leaves it off, unless Readable.
  if (!readable && !(a.width * CELL > 30 && a.height * CELL > 18)) return null
  const corner: Pt = [
    a.x + cells(AREA_NAME_LEFT_PX) - pad,
    a.y + cells(AREA_NAME_TOP_PX) - pad,
  ]
  return {
    ...base,
    at: rotatePoint(corner, boxCenter(a), a.rotation),
    pivot: [0, 0],
    rotation: a.rotation,
    room: {
      outline: boxCorners(a),
      angles: [readableAngle(a.rotation + 90)],
    },
  }
}

/** A placed label as the room writes it: its text at its real size,
 * turned with it, on its plate when it has one. */
export function labelText(
  l: LabelShape,
  cellMm: number,
  dark: boolean
): PlanTextItem | null {
  if (!l.text.trim()) return null
  const box = labelBox(l, cellMm)
  return {
    id: `label:${l.id}`,
    kind: "label",
    lines: l.text.split("\n"),
    fontCells: labelFontCells(l.font_mm, cellMm),
    weight: l.weight === "bold" ? 700 : 400,
    align: l.align,
    at: boxCenter(box),
    pivot: [0.5, 0.5],
    rotation: l.rotation,
    minBox: { w: box.width, h: box.height },
    elevation: FLOOR_TEXT_Y,
    ink: labelInk3D(l, dark),
  }
}

/** A zone's name: its label, in its colour, at its top left. */
export function zoneText(t: SceneTile, dark: boolean): PlanTextItem | null {
  if (!t.is_zone || !t.label) return null
  const pad = cells(ZONE_NAME_PX) * FLAT_PAD_EM
  // Its top-left corner turned with it, as the 2D canvas draws it.
  const pose = tilePose(t)
  const corner: Pt = [
    t.x + cells(ZONE_NAME_LEFT_PX) - pad,
    t.y + cells(ZONE_NAME_TOP_PX) - pad,
  ]
  return {
    id: `zone:${t.id}`,
    kind: "zone",
    lines: [clipName(t.label)],
    fontCells: cells(ZONE_NAME_PX),
    weight: 500,
    align: "left",
    at: rotatePoint(corner, [pose.cx, pose.cy], pose.residual),
    pivot: [0, 0],
    rotation: pose.residual,
    room: {
      outline: boxCorners({
        x: t.x,
        y: t.y,
        width: t.w,
        height: t.h,
        rotation: pose.residual,
      }),
      angles: [readableAngle(pose.residual + 90)],
    },
    elevation: FLOOR_TEXT_Y,
    ink: {
      color: t.color || "#71717a",
      halo: pageInk(dark).page,
      haloAlpha: 0.8,
      plate: null,
      plateBorder: null,
    },
  }
}

/** A tray's name as the 2D plan writes it: name, cables, hidden ones. */
export function trayName(t: SceneTray): string {
  if (!t.name) return ""
  const count = t.cable_count
  const hidden = t.hidden_cable_count ?? 0
  return (
    t.name +
    (count > 0 ? ` · ${count}` : "") +
    (hidden > 0 ? ` · ${hidden} hidden` : "")
  )
}

/** The middle of a run's longest leg (cells) - where its name plate
 * floats. */
export function longestLegMiddle(points: readonly Pt[]): Pt | null {
  let best: Pt | null = null
  let len = -1
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const l = Math.hypot(bx - ax, by - ay)
    if (l > len) {
      len = l
      best = [(ax + bx) / 2, (ay + by) / 2]
    }
  }
  return best
}

/** A tray's name plate over its run. */
export function trayText(
  plan: ScenePayload["plan"],
  t: SceneTray,
  raised?: SceneRaisedFloor[]
): PlanTextItem | null {
  const name = trayName(t)
  const at = name ? longestLegMiddle(t.points) : null
  if (!at) return null
  return {
    id: `tray:${t.id}`,
    kind: "tray",
    lines: [clipName(name)],
    fontCells: 0,
    weight: 600,
    align: "center",
    at,
    pivot: [0.5, 0.5],
    rotation: 0,
    // Over the basket.
    elevation: trayElevationM(plan, t, raised) + 0.12,
    ink: {
      color: "",
      halo: null,
      haloAlpha: 0,
      plate: null,
      plateBorder: null,
    },
  }
}

/**
 * Everything the plan writes on a level, as the Display menu asks: the
 * labels and tray names (Labels), the rooms' and areas' names (Room &
 * area names) and the zones' names (Zone labels). `shapes` are those on
 * show - the eyes have already taken the hidden ones out.
 */
export function planTexts({
  scene,
  areas,
  labels,
  show,
  dark,
}: {
  scene: Pick<ScenePayload, "plan" | "tiles" | "trays" | "raised_floors">
  areas: readonly AreaShape[]
  labels: readonly LabelShape[]
  show: PlanTextShow
  dark: boolean
}): PlanTextItem[] {
  const out: PlanTextItem[] = []
  const push = (i: PlanTextItem | null) => {
    if (i) out.push(i)
  }
  if (show.labels) {
    for (const l of labels) push(labelText(l, scene.plan.cell_mm, dark))
    for (const t of scene.trays)
      push(trayText(scene.plan, t, scene.raised_floors))
  }
  if (show.zoneNames) for (const t of scene.tiles) push(zoneText(t, dark))
  if (show.areaNames)
    for (const a of areas) push(areaText(a, dark, show.readable))
  return out
}

// ── Placement on screen ───────────────────────────────────────────────────

/** Below this sine of the camera's height over the text (about 15°) flat
 * text stands up as a billboard; it lies back down over FLAT_ENTER - two
 * thresholds, so a camera hovering at the edge does not flicker. */
export const FLAT_EXIT = 0.26
export const FLAT_ENTER = 0.34

export type PlanTextMode = "flat" | "billboard"

/** Flat or a billboard, from the sine of the camera's elevation over the
 * text and how it was drawn last. */
export function planTextMode(
  sinElevation: number,
  prev: PlanTextMode = "flat"
): PlanTextMode {
  if (prev === "flat") return sinElevation < FLAT_EXIT ? "billboard" : "flat"
  return sinElevation > FLAT_ENTER ? "flat" : "billboard"
}

/** Readable: no plan text under this on screen (px). */
export const PLAN_TEXT_MIN_PX = READABLE_FONT_PX + 1
/** Real size: text under this on screen (px) is too small to read and is
 * left out (nor does it crowd anything). */
export const PLAN_TEXT_TINY_PX = 3

/** A flat quad on the plan (cells): its middle and corners (top left,
 * clockwise) - `w` × `h`, grown by `grow` about its pivot, slid `shift`
 * along its own axes. */
export function flatQuad(
  item: Pick<PlanTextItem, "at" | "pivot" | "rotation">,
  w: number,
  h: number,
  grow = 1,
  shift: Pt = [0, 0]
): { centre: Pt; corners: Pt[] } {
  const gw = w * grow
  const gh = h * grow
  // The middle, in the quad's own (unturned) frame round the pivot.
  const local: Pt = [
    item.at[0] + (0.5 - item.pivot[0]) * gw + shift[0] * grow,
    item.at[1] + (0.5 - item.pivot[1]) * gh + shift[1] * grow,
  ]
  const centre = rotatePoint(local, item.at, item.rotation)
  const corners = (
    [
      [-gw / 2, -gh / 2],
      [gw / 2, -gh / 2],
      [gw / 2, gh / 2],
      [-gw / 2, gh / 2],
    ] as Pt[]
  ).map((d) =>
    rotatePoint([centre[0] + d[0], centre[1] + d[1]], centre, item.rotation)
  )
  return { centre, corners }
}

/** The upright screen box round some screen points. */
export function screenBounds(pts: readonly Pt[]): {
  x: number
  y: number
  w: number
  h: number
} {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

/** A text's priority in the pass: its kind's rank, the nearer first. */
export function planTextPriority(kind: PlanTextKind, distance: number) {
  return PLAN_TEXT_RANK[kind] - Math.min(distance, 1e6 - 1)
}

/** The plan texts that show when no Readable plates take part: no two
 * overlapping on screen, the higher ranked first. */
export function layoutPlanTexts(cands: readonly NameCandidate[]): Set<string> {
  return thinNames(cands)
}
