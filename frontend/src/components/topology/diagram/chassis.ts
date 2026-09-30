import type { TopoNode } from "@/lib/api"
import { BAND as PRINT_BAND } from "@/lib/diagram/theme"
import type { Pt, Rect, Side } from "./types"

// A virtual chassis on the Diagram (a switch stack): its members drawn
// together in one frame, top to bottom ("v") or left to right ("h"), with
// a slim strip along the frame's side carrying the chassis' name - down
// the left of a top-to-bottom stack, across the top of a left-to-right
// one. The frame is a node of its own (`vc:<chassis id>`), laid out and
// saved like a card; its members are placed round its centre, so the
// stack always stays packed whatever size its cards are drawn at. Pure
// geometry and grouping, shared by the build, the canvas and the exports.

/** How a chassis' members stand: top to bottom, or left to right. */
export type ChassisOrient = "v" | "h"
/** The view's stacking: apart, or the way a chassis stacks by default. */
export type ChassisMode = "off" | ChassisOrient

export const CHASSIS_MODES: readonly ChassisMode[] = ["off", "v", "h"]

/** One chassis' own look on a view (`state.chassis[<id>]`). */
export interface ChassisLook {
  orient?: ChassisOrient
  /** Drawn apart, whatever the view's stacking. */
  off?: boolean
}

/** What the build is told about stacking. Plain data (it crosses to the
 * Diagram worker). */
export interface ChassisOptions {
  mode: ChassisMode
  /** Per chassis id. */
  looks?: Readonly<Record<string, ChassisLook>>
  /** Chassis placed on a hand-picked map: stacked even with one member on
   * the map, and even when the view's stacking is off. */
  placed?: readonly string[]
}

/** A device node's chassis, as the topology API sends it. */
export interface NodeChassis {
  id: string
  name: string
  position: number | null
  master: boolean
}

/** A device node's data with its chassis (`vc`, on members only). */
export type WithChassis = TopoNode["data"] & { vc?: NodeChassis }

export const CHASSIS = {
  /** Between two members. */
  GAP: 4,
  /** Between the members and the frame, room for a nub on the outside. */
  PAD: 8,
  /** The name strip's thickness (the exports draw it the same). */
  STRIP: PRINT_BAND.CHASSIS_STRIP,
  TITLE_SIZE: PRINT_BAND.CHASSIS_SIZE,
  TITLE_WEIGHT: 600,
} as const

/** A frame node's grip: its name strip. */
export const CHASSIS_DRAG_HANDLE = "chassis-grip"

/** A frame's node-wrapper classes: blended with the cables it lies under,
 * as a layer band is (band-node.tsx). */
export const CHASSIS_NODE_CLASS = "mix-blend-darken dark:mix-blend-lighten"

/** A stacked chassis' frame node id. */
export const chassisNodeId = (vc: string) => `vc:${vc}`
export const isChassisNode = (id: string) => id.startsWith("vc:")

/** The chassis a node's data names, when it is a member of one. */
export function vcOf(data: unknown): NodeChassis | undefined {
  const vc = (data as { vc?: unknown } | null | undefined)?.vc
  if (!vc || typeof vc !== "object") return undefined
  const v = vc as Partial<NodeChassis>
  return typeof v.id === "string" && typeof v.name === "string"
    ? {
        id: v.id,
        name: v.name,
        position: typeof v.position === "number" ? v.position : null,
        master: v.master === true,
      }
    : undefined
}

/** A stacked chassis: its frame's id, and its members in stack order. */
export interface ChassisSpec {
  /** The frame node (`vc:<chassis id>`). */
  id: string
  vc: { id: string; name: string }
  orient: ChassisOrient
  /** Member node ids, top to bottom (left to right). */
  members: string[]
}

const byName = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })

/** How a chassis draws: its orientation, or null to draw it apart. */
export function chassisOrient(
  vc: string,
  opts: ChassisOptions | undefined
): ChassisOrient | null {
  if (!opts) return null
  const look = opts.looks?.[vc]
  if (look?.off) return null
  if (look?.orient) return look.orient
  if (opts.mode !== "off") return opts.mode
  return opts.placed?.includes(vc) ? "v" : null
}

/**
 * The chassis that stack on a map: every chassis with two members on it
 * or placed on it by hand, unless it or the view draws it apart. Members
 * stand by their member number, those without one last by name.
 */
export function chassisSpecs(
  nodes: readonly { id: string; type?: string; data: unknown }[],
  opts: ChassisOptions | undefined
): ChassisSpec[] {
  if (!opts) return []
  const groups = new Map<
    string,
    {
      vc: NodeChassis
      members: { id: string; pos: number | null; name: string }[]
    }
  >()
  for (const n of nodes) {
    if (n.type !== "device") continue
    const vc = vcOf(n.data)
    if (!vc) continue
    const g = groups.get(vc.id) ?? { vc, members: [] }
    g.members.push({
      id: n.id,
      pos: vc.position,
      name: String((n.data as { name?: unknown }).name ?? ""),
    })
    groups.set(vc.id, g)
  }
  const placed = new Set(opts.placed ?? [])
  const out: ChassisSpec[] = []
  for (const [id, g] of groups) {
    if (g.members.length < 2 && !placed.has(id)) continue
    const orient = chassisOrient(id, opts)
    if (!orient) continue
    g.members.sort(
      (a, b) =>
        (a.pos === null ? 1 : 0) - (b.pos === null ? 1 : 0) ||
        (a.pos ?? 0) - (b.pos ?? 0) ||
        byName(a.name, b.name) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    )
    out.push({
      id: chassisNodeId(id),
      vc: { id, name: g.vc.name },
      orient,
      members: g.members.map((m) => m.id),
    })
  }
  return out.sort((a, b) => byName(a.vc.name, b.vc.name))
}

export interface Size {
  w: number
  h: number
}

export interface ChassisGeometry extends Size {
  /** Each member's centre, from the frame's centre. */
  offsets: Pt[]
  /** The name strip, from the frame's top-left corner. */
  strip: Rect
}

/**
 * A frame round members of `sizes`, in stack order: top to bottom with
 * their left edges lined up (`v`, the strip down the left), or left to
 * right with their tops lined up (`h`, the strip across the top). `gaps`
 * is the room between member i and i + 1 (`CHASSIS.GAP` by default).
 */
export function chassisGeometry(
  orient: ChassisOrient,
  sizes: readonly Size[],
  gaps: readonly number[] = []
): ChassisGeometry {
  const { PAD, STRIP } = CHASSIS
  const gap = (i: number) => gaps[i] ?? CHASSIS.GAP
  const along = sizes.reduce(
    (s, b, i) => s + (orient === "v" ? b.h : b.w) + (i ? gap(i - 1) : 0),
    0
  )
  const across = Math.max(0, ...sizes.map((b) => (orient === "v" ? b.w : b.h)))
  const w = orient === "v" ? STRIP + 2 * PAD + across : 2 * PAD + along
  const h = orient === "v" ? 2 * PAD + along : STRIP + 2 * PAD + across
  const offsets: Pt[] = []
  let at = PAD
  sizes.forEach((b, i) => {
    if (i) at += gap(i - 1)
    const c =
      orient === "v"
        ? { x: STRIP + PAD + b.w / 2, y: at + b.h / 2 }
        : { x: at + b.w / 2, y: STRIP + PAD + b.h / 2 }
    offsets.push({ x: c.x - w / 2, y: c.y - h / 2 })
    at += orient === "v" ? b.h : b.w
  })
  return {
    w,
    h,
    offsets,
    strip:
      orient === "v"
        ? { x: 0, y: 0, w: STRIP, h }
        : { x: 0, y: 0, w, h: STRIP },
  }
}

/** The frame round members standing at `rects` (in stack order). */
export function chassisFrame(
  orient: ChassisOrient,
  rects: readonly Rect[]
): Rect {
  const { PAD, STRIP } = CHASSIS
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x0 = Math.min(...rects.map((r) => r.x))
  const y0 = Math.min(...rects.map((r) => r.y))
  const x1 = Math.max(...rects.map((r) => r.x + r.w))
  const y1 = Math.max(...rects.map((r) => r.y + r.h))
  const left = orient === "v" ? STRIP + PAD : PAD
  const top = orient === "h" ? STRIP + PAD : PAD
  return {
    x: x0 - left,
    y: y0 - top,
    w: x1 - x0 + left + PAD,
    h: y1 - y0 + top + PAD,
  }
}

/** A frame's name strip. */
export function chassisStrip(orient: ChassisOrient, frame: Rect): Rect {
  return orient === "v"
    ? { x: frame.x, y: frame.y, w: CHASSIS.STRIP, h: frame.h }
    : { x: frame.x, y: frame.y, w: frame.w, h: CHASSIS.STRIP }
}

/** The sides of member `i` of `n` that face another member: no cable
 * leaves by them. */
export function innerSides(
  orient: ChassisOrient,
  i: number,
  n: number
): Set<Side> {
  const out = new Set<Side>()
  if (i > 0) out.add(orient === "v" ? "T" : "L")
  if (i < n - 1) out.add(orient === "v" ? "B" : "R")
  return out
}

/**
 * `boxes` with each stacked chassis' members replaced by its frame: what
 * a band sees when it sorts or carries cards. `frames` maps a frame id to
 * its member ids; a frame with none of them in `boxes` is left out.
 */
export function collapseChassis(
  boxes: Readonly<Record<string, Rect>>,
  frames: ReadonlyMap<
    string,
    { orient: ChassisOrient; members: readonly string[] }
  >
): Record<string, Rect> {
  if (!frames.size) return { ...boxes }
  const out: Record<string, Rect> = { ...boxes }
  for (const [id, f] of frames) {
    const rects = f.members.flatMap((m) => {
      const r = boxes[m] as Rect | undefined
      return r ? [r] : []
    })
    for (const m of f.members) delete out[m]
    if (rects.length) out[id] = chassisFrame(f.orient, rects)
  }
  return out
}

/** The chassis a node belongs to, from a frame list. */
export function memberFrames(
  frames: ReadonlyMap<string, { members: readonly string[] }>
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, f] of frames) for (const m of f.members) out.set(m, id)
  return out
}
