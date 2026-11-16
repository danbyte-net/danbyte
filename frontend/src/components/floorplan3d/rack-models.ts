import { OPENING_MM, PANEL_MM } from "@/lib/faceplate-geometry"

import { deviceYM, mm } from "./world"
import type { SceneDevice, SceneRack } from "./world"

/**
 * Racked devices drawing their 3D models (docs/features/floor-plans.md →
 * 3D models in racks): the pure part - where a fitted model sits in its
 * rack slot, which level of detail a device wants at a distance, and how
 * the room's triangle budget is shared out. No three.js objects, so it
 * tests without a canvas; rack-model-draw.tsx applies it.
 *
 * A model's fitted frame (device-model `fittedModel`) stands it on its own
 * origin, centred across and front to back, its front on −Z. A rack's
 * frame has its front plane on −Z too (rack-mesh), so a front-mounted
 * device needs no turn and a rear-mounted one a half turn about Y.
 */

/** How far in from the cabinet's front and rear planes the rails sit, as a
 * share of its depth - where `deviceBoxM` puts a box's face. */
export const RAIL_INSET_FRAC = 0.45

/** The width a racked device's front spans (m): the rail opening plus the
 * mounting ears - a 19" rack's 482.6 mm frame. Half-width gear spans half
 * of it. */
export function rackFrameWidthM(rack: Pick<SceneRack, "width">): number {
  const opening = OPENING_MM[rack.width] ?? PANEL_MM.opening
  return mm(opening + (PANEL_MM.earWidth - PANEL_MM.opening))
}

/** The box a racked device's model is fitted into (m): the frame width
 * (half of it for half-width gear) and its units tall. Depth is left to
 * the model - it keeps its own proportions. */
export function rackSlotTargetM(
  rack: Pick<SceneRack, "width">,
  dev: Pick<SceneDevice, "u_height" | "rack_width">
): { w: number; h: number } {
  const frame = rackFrameWidthM(rack)
  return {
    w: dev.rack_width === "half" ? frame / 2 : frame,
    h: mm(Math.max(dev.u_height, 1) * PANEL_MM.uPitch),
  }
}

/** Where a fitted model stands in its rack (the rack group's frame, m):
 * its origin's place and its turn about Y. */
export interface SlotPose {
  position: [number, number, number]
  rotY: number
}

/**
 * A fitted model's pose in its slot. `size` is the fitted upright size
 * (w, h, d in metres). Its bottom sits on the slot's lowest unit - centred
 * in the slot's height when it is a little shorter, as real gear is - and
 * across where the box would stand (half-width gear on its side). A
 * front-mounted device's front sits on the front rail plane and it runs
 * back from there; a rear-mounted one is turned round, its front on the
 * rear rail plane.
 */
export function rackSlotPose(
  rack: SceneRack,
  dev: SceneDevice,
  rackDepthM: number,
  size: readonly [number, number, number]
): SlotPose {
  const { y } = deviceYM(rack, dev)
  const slotH = mm(Math.max(dev.u_height, 1) * PANEL_MM.uPitch)
  const lift = Math.max(0, (slotH - size[1]) / 2)
  const openM = mm(OPENING_MM[rack.width] ?? PANEL_MM.opening)
  const x =
    dev.rack_side === "left"
      ? -openM * 0.25
      : dev.rack_side === "right"
        ? openM * 0.25
        : 0
  const rail = rackDepthM * RAIL_INSET_FRAC
  const rear = dev.face === "rear"
  const z = rear ? rail - size[2] / 2 : -rail + size[2] / 2
  return { position: [x, y + lift, z], rotY: rear ? Math.PI : 0 }
}

/** A point in a rack's frame in the room: turned by the rack's facing
 * (three's rotation about Y) and moved to its tile's centre. */
export function rackToWorld(
  centre: readonly [number, number],
  rotY: number,
  p: readonly [number, number, number]
): [number, number, number] {
  const c = Math.cos(rotY)
  const s = Math.sin(rotY)
  return [
    centre[0] + c * p[0] + s * p[2],
    p[1],
    centre[1] - s * p[0] + c * p[2],
  ]
}

// ── level of detail ─────────────────────────────────────────────────────────

/** What a racked device draws: its full assembled model, its far copy
 * (instanced across identical devices), or the box with its face photos. */
export type RackModelLevel = "full" | "far" | "box"

/** Switch distances (m, eye to the device's centre), each with a gap so a
 * device on the edge doesn't flicker between two looks. */
export const RACK_FULL_IN_M = 3.5
export const RACK_FULL_OUT_M = 4.5
export const RACK_FAR_IN_M = 9
export const RACK_FAR_OUT_M = 11

/** The level a device wants at `dist`, given the one it has now. */
export function wantedRackLevel(
  dist: number,
  current: RackModelLevel
): RackModelLevel {
  const full = current === "full" ? RACK_FULL_OUT_M : RACK_FULL_IN_M
  if (dist < full) return "full"
  const far = current === "box" ? RACK_FAR_IN_M : RACK_FAR_OUT_M
  return dist < far ? "far" : "box"
}

// ── the triangle budget ─────────────────────────────────────────────────────

/** One racked device asking for a model: how far off it is, the level it
 * wants, and the triangles each level costs once loaded (null: not loaded
 * yet, or none). */
export interface ModelWant {
  id: string
  dist: number
  level: "full" | "far"
  full: number | null
  far: number | null
}

/** The share of the budget far copies of the devices up close may take
 * before the nearest of them are raised to full - the rest is kept for
 * those upgrades. Standing at a rack, a few hundred devices are "up
 * close"; their far copies alone would fill the budget. */
export const NEAR_FAR_SHARE = 0.5

/**
 * The level each device gets within `left` triangles, nearest first in
 * each pass:
 *
 * 1. the devices up close (wanting their full model) get their cheap far
 *    copy, up to `NEAR_FAR_SHARE` of the budget;
 * 2. what is left raises the nearest of them to full;
 * 3. everything still a box - up close past the share, or further off -
 *    gets a far copy with the rest.
 *
 * So the device in front of you is full, its neighbours aren't boxes, and
 * a hall of far copies never starves either. `limit` caps one device. A
 * device past the budget keeps its box - with its face photos it looks
 * right at that size.
 */
export function allocateModels(
  wants: readonly ModelWant[],
  left: number,
  limit: number
): Map<string, RackModelLevel> {
  const out = new Map<string, RackModelLevel>()
  const order = [...wants].sort(
    (a, b) => a.dist - b.dist || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const ok = (n: number | null): n is number => n !== null && n <= limit
  for (const w of order) out.set(w.id, "box")
  const giveFar = (w: ModelWant, floor: number) => {
    if (out.get(w.id) !== "box" || !ok(w.far) || left - w.far < floor) return
    out.set(w.id, "far")
    left -= w.far
  }
  const near = order.filter((w) => w.level === "full")
  const keep = left * (1 - NEAR_FAR_SHARE)
  for (const w of near) giveFar(w, keep)
  for (const w of near) {
    if (!ok(w.full)) continue
    const has = out.get(w.id) === "far" ? w.far! : 0
    if (w.full - has <= left) {
      out.set(w.id, "full")
      left -= w.full - has
    }
  }
  for (const w of order) giveFar(w, 0)
  return out
}

/**
 * The room's triangle budget, shared by every model it draws. Floor
 * devices spend first (their layer reports what it spent); racked devices
 * share what is left, nearest first, across every rack. Each rack posts
 * its devices' wants and reads back its devices' levels; listeners hear
 * only when a level changes.
 */
export interface ModelBudget {
  /** What the floor devices drew (triangles). */
  setFloor: (spent: number) => void
  /** A rack's wants, replacing its last ones; [] withdraws them. */
  setWants: (owner: string, wants: readonly ModelWant[]) => void
  /** A rack's devices' levels as one string (`id=level,…`, sorted) - a
   * snapshot that only changes when they do. */
  ownerKey: (owner: string) => string
  levelOf: (id: string) => RackModelLevel
  /** The racked devices drawn with a model now, sorted, comma-joined - the
   * room asks for their LEDs. */
  drawnKey: () => string
  subscribe: (fn: () => void) => () => void
}

export function createModelBudget(total: number, limit: number): ModelBudget {
  let floor = 0
  const wants = new Map<string, readonly ModelWant[]>()
  let levels = new Map<string, RackModelLevel>()
  let keys = new Map<string, string>()
  let drawn = ""
  const listeners = new Set<() => void>()

  const recompute = () => {
    const all: ModelWant[] = []
    for (const list of wants.values()) all.push(...list)
    levels = allocateModels(all, Math.max(0, total - floor), limit)
    const nextKeys = new Map<string, string>()
    for (const [owner, list] of wants) {
      nextKeys.set(
        owner,
        list
          .map((w) => `${w.id}=${levels.get(w.id) ?? "box"}`)
          .sort()
          .join(",")
      )
    }
    const nextDrawn = [...levels]
      .filter(([, l]) => l !== "box")
      .map(([id]) => id)
      .sort()
      .join(",")
    let changed = nextDrawn !== drawn || nextKeys.size !== keys.size
    if (!changed)
      for (const [o, k] of nextKeys)
        if (keys.get(o) !== k) {
          changed = true
          break
        }
    keys = nextKeys
    drawn = nextDrawn
    if (changed) listeners.forEach((fn) => fn())
  }

  return {
    setFloor(spent) {
      if (spent === floor) return
      floor = spent
      recompute()
    },
    setWants(owner, list) {
      if (list.length === 0) {
        if (!wants.has(owner)) return
        wants.delete(owner)
      } else {
        wants.set(owner, list)
      }
      recompute()
    },
    ownerKey: (owner) => keys.get(owner) ?? "",
    levelOf: (id) => levels.get(id) ?? "box",
    drawnKey: () => drawn,
    subscribe(fn) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** `id=level,…` (an `ownerKey`) back into a map. */
export function parseLevels(key: string): Map<string, RackModelLevel> {
  const out = new Map<string, RackModelLevel>()
  if (!key) return out
  for (const part of key.split(",")) {
    const i = part.lastIndexOf("=")
    out.set(part.slice(0, i), part.slice(i + 1) as RackModelLevel)
  }
  return out
}

/** Devices drawing the same far copy with the same parts and covers are
 * one instanced group: what tells two of them apart. */
export function instanceGroupKey(
  chassisUrl: string,
  parts: readonly { bay: string; url: string }[],
  bays: readonly { name: string; installed: boolean }[] | null,
  emptyMode: string
): string {
  return [
    chassisUrl,
    parts.map((p) => `${p.bay}\u0001${p.url}`).join("\u0002"),
    bays
      ? bays.map((b) => `${b.name}\u0001${b.installed ? 1 : 0}`).join("\u0002")
      : "-",
    emptyMode,
  ].join("\u0000")
}
