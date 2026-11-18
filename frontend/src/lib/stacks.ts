import type { DeviceLeds } from "@/lib/led-state"
import type { PortPlug } from "@/lib/port-plugs"
import type { StacksMode } from "@/lib/stacks-pref"
import {
  add,
  bendMm,
  cordLead,
  cross,
  dot,
  jacketCount,
  len,
  mul,
  roundCorners,
  runCable,
  sub,
  unit,
} from "@/lib/cord-run"
import type { CordEnd, Vec3 } from "@/lib/cord-run"

/**
 * Switch stacks in 3D (docs/dcim/virtual-chassis.md → In 3D): the server
 * names each stack among a view's devices and the stack cables between its
 * drawn members (`/api/device-leds/` `stacks`, api.stack_links) - the
 * recorded ones, else the ring derived from member order. Here are the
 * pure parts: no three.js, so they test without a canvas.
 */

/** A member's stack, for its hover card and the device card. */
export interface DeviceStack {
  id: string
  name: string
  /** Its member number. */
  position: number
  /** It is the stack's master. */
  master: boolean
  master_name: string | null
}

/** A part at a stack cable's end: a plug row (lib/port-plugs), the head
 * as its `cord_part`. */
export interface StackPlug extends PortPlug {
  /** The cable is derived from member order, not recorded. */
  derived?: boolean
}

/** One end of a stack cable: the member, its port anchor as drawn, the
 * interface. */
export interface StackLinkEnd {
  device: string
  port: string
  name: string
  /** The interface's or power port's id (Record cable's termination);
   * absent from an older server. */
  id?: string
}

/** What a stack cable carries: the stack's data (StackWise and the
 * like) or its power (StackPower). */
export type StackLinkKind = "data" | "power"

export interface StackLink {
  a: StackLinkEnd
  b: StackLinkEnd
  /** A data stack cable or a StackPower cable; absent from an older
   * server, read as data. */
  kind?: StackLinkKind
  /** Drawn from member order: no cable is recorded. */
  derived: boolean
  /** The recorded cable, or null. */
  cable: string | null
  color: string | null
  label: string
  /** A recorded cable's length in metres, or null: its loop is drawn to
   * it (`stackRunPoints`). */
  length_m?: number | null
  /** The head's part numbers - the lengths Record cable offers. */
  parts?: string[]
}

export interface SceneStack {
  id: string
  name: string
  /** The master's device id, when the reader may view it. */
  master: string | null
  members: { device: string; name: string; position: number }[]
  links: StackLink[]
}

/**
 * A device's payload entry as the viewer's Stacks choice draws it: shown
 * or ghosted, the covers a derived ring hides join the covers; hidden,
 * the stack cables' parts go and those covers come back. Recorded cables
 * hide their covers either way - the server counts them in `covers`.
 */
export function withStackMode(dev: DeviceLeds, mode: StacksMode): DeviceLeds {
  const extra = dev.stack_covers ?? []
  const parts = dev.stack_plugs ?? []
  if (!extra.length && !parts.length) return dev
  if (mode === "hide") return { ...dev, stack_plugs: [] }
  if (!extra.length) return dev
  return {
    ...dev,
    covers: [...new Set([...(dev.covers ?? []), ...extra])].sort(),
  }
}

/** Every entry of a view's payload as `withStackMode` draws it. */
export function stackModeLeds(
  leds: Readonly<Record<string, DeviceLeds>>,
  mode: StacksMode
): Record<string, DeviceLeds> {
  const out: Record<string, DeviceLeds> = {}
  for (const [id, dev] of Object.entries(leds))
    out[id] = withStackMode(dev, mode)
  return out
}

/** A device's stack in a view's payload, or null (not drawn, or no
 * member). */
export function stackOf(
  leds: Readonly<Partial<Record<string, DeviceLeds>>>,
  deviceId: string
): DeviceStack | null {
  return leds[deviceId]?.stack ?? null
}

/** The ids of every member of `stackId` in `stacks`. */
export function stackMembers(
  stacks: readonly SceneStack[],
  stackId: string | null | undefined
): ReadonlySet<string> {
  const s = stackId ? stacks.find((x) => x.id === stackId) : undefined
  return new Set(s?.members.map((m) => m.device) ?? [])
}

/** The cable ids the stack layer draws (the room's cables layer leaves
 * them out). */
export function stackCableIds(stacks: readonly SceneStack[]): Set<string> {
  const out = new Set<string>()
  for (const s of stacks) for (const l of s.links) if (l.cable) out.add(l.cable)
  return out
}

/** The member line of a hover card: `Member 2`, `Member 1 · master`. */
export function memberText(stack: DeviceStack): string {
  return `Member ${stack.position}${stack.master ? " · master" : ""}`
}

/** A stack cable's name in its hover card. */
export function stackLinkText(
  link: Pick<StackLink, "derived" | "kind">
): string {
  const name = link.kind === "power" ? "StackPower cable" : "Stack cable"
  return link.derived ? `${name} (derived from member order)` : name
}

// ── the run ──────────────────────────────────────────────────────────────

/** How far a stack cable's loop hangs below the lower of its two ends
 * at least (m, before the model's scale); it hangs at least two of its
 * bends deep, so both turns at the bottom keep their radius. */
export const STACK_SAG_M = 0.06
/** A plain stack cable's jacket (mm) when no head names one. */
export const STACK_JACKET_MM = 6
/** Its tightest bend (m) when no head names one. */
export const STACK_MIN_BEND_M = 0.03

const UP: Vec3 = [0, 1, 0]

/** The level way out of the back of the stack at two ends: their heads'
 * mean +Z laid flat, else the A end's, else +Z. */
export function stackHangDir(a: CordEnd, b: CordEnd): Vec3 {
  const flat = (v: Vec3): Vec3 => sub(v, mul(UP, dot(v, UP)))
  for (const v of [add(unit(a.z), unit(b.z)), unit(a.z), unit(b.z)]) {
    const f = flat(v)
    if (len(f) > 1e-3) return unit(f)
  }
  return [0, 0, 1]
}

/** Where one stack cable hangs among the others of its stack
 * (`stackRuns`): its `lane` counted out from the stack, the `plane` (along
 * the hang direction) the lane's loop hangs in, how far its drops move in
 * from its ports (`shift`), and the loop's `bottom` (y) at the most. */
export interface StackLane {
  lane: number
  /** One lane's width: a jacket diameter and the gap. */
  pitch: number
  plane: number
  shift: number
  bottom: number
}

/** How long a cable hangs at the most below its lower end before the rest
 * of a long cable folds back along the floor of the loop (m, before the
 * model's scale). */
export const STACK_MAX_SAG_M = 0.6

/** The gap between two cables lying side by side (m, before scale). */
export const STACK_LANE_GAP_M = 0.003

/** The polyline length of `points`. */
export function pathLength(points: readonly Vec3[]): number {
  let n = 0
  for (let i = 1; i < points.length; i++)
    n += len(sub(points[i], points[i - 1]))
  return n
}

/**
 * The run of one stack cable between its ends (the heads' `cable`
 * empties, or the port anchors when no head is drawn), as a StackWise
 * cable hangs: each end's short lead out along its +Z, a tight bend down
 * one bend radius behind the furthest lead, a drop past the members, a
 * loop under the lower end and back up - the whole loop in one upright
 * plane behind the ports (`stackHangDir`), so a cable between adjacent
 * members never passes through a chassis. The loop's bottom is at least
 * two bends wide and deep; every corner is rounded to the head's bend
 * (`stackBendM`) where the segments leave room.
 *
 * With a `lane` (`stackRuns`) the loop hangs in that lane's plane, its
 * drops moved in from the ports by its shift, its bottom no lower than
 * the lane's. A recorded `length_m` sizes the loop: it hangs as deep as
 * the cable is long (never shorter than the lane's run), at most
 * `STACK_MAX_SAG_M`, the rest folded back along the bottom. The same ends
 * give the same points.
 */
export function stackRunPoints(
  a: CordEnd,
  b: CordEnd,
  link?: Pick<StackLink, "derived" | "label" | "length_m"> | null,
  lane?: StackLane | null
): Vec3[] {
  const scale = a.scale || 1
  const r = stackBendM(a, b, link) * scale
  const [a0, a1] = cordLead(a)
  const [b0, b1] = cordLead(b)
  const h = stackHangDir(a, b)
  // The hanging plane: one bend behind the furthest lead, or the lane's.
  const plane = lane
    ? Math.max(lane.plane, Math.max(dot(a1, h), dot(b1, h)) + r)
    : Math.max(dot(a1, h), dot(b1, h)) + r
  const aP = add(a1, mul(h, plane - dot(a1, h)))
  const bP = add(b1, mul(h, plane - dot(b1, h)))
  // The drops move in from the ports, toward each other, by the lane's
  // shift - never past the middle.
  let side = sub(bP, aP)
  side = sub(side, mul(UP, dot(side, UP)))
  const span = len(side)
  side = span > 1e-6 ? unit(side) : unit(cross(UP, h))
  // (Kept a lane apart at the middle; the bend there is best-effort.)
  const shift = lane
    ? Math.min(lane.shift, Math.max(0, span / 2 - lane.pitch / 2))
    : 0
  const aS = span > 1e-6 ? shift : lane ? lane.shift : 0
  const a2 = add(aP, mul(side, aS))
  const b2 = span > 1e-6 ? sub(bP, mul(side, shift)) : add(bP, mul(side, aS))
  const deepest = Math.min(a2[1], b2[1]) - 2 * r
  let bottom = Math.min(a2[1], b2[1]) - Math.max(STACK_SAG_M * scale, 2 * r)
  if (lane) bottom = Math.min(lane.bottom, deepest)
  const shape = (bot: number, fold: number): Vec3[] => {
    let a3: Vec3 = [a2[0], bot, a2[2]]
    let b3: Vec3 = [b2[0], bot, b2[2]]
    // Ends right above each other: spread the loop's bottom to two bends,
    // sideways in the plane - in a lane, no wider than its drops (a lane
    // apart at least), so it never swings into a neighbour's lead.
    const across = sub(b3, a3)
    const wide = lane
      ? Math.min(2 * r, Math.max(len(across), lane.pitch))
      : 2 * r
    if (len(across) < wide) {
      const s2 = len(across) > 1e-6 ? unit(across) : side
      const mid = mul(add(a3, b3), 0.5)
      a3 = sub(mid, mul(s2, wide / 2))
      b3 = add(mid, mul(s2, wide / 2))
    }
    // A long cable's rest lies back along the bottom, away from the stack.
    const tail: Vec3[] =
      fold > 1e-6 ? [add(a3, mul(h, fold)), add(b3, mul(h, fold))] : []
    return roundCorners(
      straightened([a0, a1, aP, a2, a3, ...tail, b3, b2, bP, b1, b0]),
      r
    )
  }
  const want = link && !link.derived ? (link.length_m ?? 0) * scale : 0
  if (!(want > 0)) return shape(bottom, 0)
  const top = bottom
  const floor = Math.min(a2[1], b2[1]) - STACK_MAX_SAG_M * scale
  if (pathLength(shape(top, 0)) >= want || floor >= top) return shape(top, 0)
  const deep = shape(floor, 0)
  const deepLen = pathLength(deep)
  if (deepLen < want) return shape(floor, (want - deepLen) / 2)
  // Longer hangs lower: the bottom that makes the run the cable's length.
  let lo = floor
  let hi = top
  for (let i = 0; i < 32; i++) {
    const mid = (lo + hi) / 2
    if (pathLength(shape(mid, 0)) > want) lo = mid
    else hi = mid
  }
  return shape((lo + hi) / 2, 0)
}

/** One stack cable for `stackRuns`: its key, ends and link. */
export interface StackRunInput {
  key: string
  a: CordEnd
  b: CordEnd
  link: Pick<StackLink, "derived" | "label" | "length_m" | "kind">
}

/**
 * The runs of one stack's cables together, so they lie beside and on each
 * other instead of through each other: ordered by their upper end, lowest
 * first, then data before power, then key; each takes the first lane no
 * earlier cable across the same width holds. A lane is one jacket
 * diameter and `STACK_LANE_GAP_M` further out from the stack, its drops
 * moved in from the ports as far (so a lead out to an outer lane passes
 * beside the inner drops), and its loop rests on the one inside it: its
 * bottom a jacket higher, all below the lowest end of the cables it
 * shares the width with. Pure: the same ends give the same lanes.
 */
export function stackRuns(runs: readonly StackRunInput[]): Map<string, Vec3[]> {
  const out = new Map<string, Vec3[]>()
  if (!runs.length) return out
  const scale = runs[0].a.scale || 1
  const rmax = Math.max(...runs.map((x) => stackRadiusM(x.a, x.b)))
  const pitch = 2 * rmax + STACK_LANE_GAP_M * scale
  const h = stackHangDir(runs[0].a, runs[0].b)
  const across = unit(cross(UP, h))
  const info = runs.map((x) => {
    const r = stackBendM(x.a, x.b, x.link) * scale
    const [, a1] = cordLead(x.a)
    const [, b1] = cordLead(x.b)
    const ua = dot(a1, across)
    const ub = dot(b1, across)
    return {
      x,
      r,
      lo: Math.min(ua, ub) - pitch,
      hi: Math.max(ua, ub) + pitch,
      top: Math.max(a1[1], b1[1]),
      low: Math.min(a1[1], b1[1]),
      lead: Math.max(dot(a1, h), dot(b1, h)) + r,
    }
  })
  const order = info
    .map((_, i) => i)
    .sort((i, j) => {
      const p = info[i]
      const q = info[j]
      if (Math.abs(p.top - q.top) > 1e-6) return p.top - q.top
      const kp = p.x.link.kind === "power" ? 1 : 0
      const kq = q.x.link.kind === "power" ? 1 : 0
      if (kp !== kq) return kp - kq
      return p.x.key < q.x.key ? -1 : p.x.key > q.x.key ? 1 : 0
    })
  const lanes: number[] = new Array(runs.length).fill(0)
  const placed: number[] = []
  for (const i of order) {
    const p = info[i]
    const taken = new Set(
      placed
        .filter((j) => info[j].lo < p.hi && p.lo < info[j].hi)
        .map((j) => lanes[j])
    )
    let lane = 0
    while (taken.has(lane)) lane++
    lanes[i] = lane
    placed.push(i)
  }
  // Each overlapping group's plane and floor.
  for (const i of order) {
    const p = info[i]
    const near = info.filter((q) => q.lo < p.hi && p.lo < q.hi)
    const base = Math.max(...near.map((q) => q.lead))
    const lowest = Math.min(...near.map((q) => q.low))
    const sag = Math.max(STACK_SAG_M * scale, 2 * p.r)
    const lane = lanes[i]
    const bottom = Math.min(
      lowest - sag + lane * pitch,
      lowest - 2 * p.r - pitch
    )
    out.set(
      p.x.key,
      stackRunPoints(p.x.a, p.x.b, p.x.link, {
        lane,
        pitch,
        plane: base + lane * pitch,
        shift: (lane + 1) * pitch,
        bottom,
      })
    )
  }
  return out
}

/** `points` without the inner ones that make no turn or no length, so a
 * corner gets the whole of a straight run to round on. */
export function straightened(points: readonly Vec3[]): Vec3[] {
  const out: Vec3[] = []
  for (const p of points) {
    if (out.length && len(sub(p, out[out.length - 1])) < 1e-6) continue
    while (out.length >= 2) {
      const u = unit(sub(out[out.length - 1], out[out.length - 2]))
      const v = unit(sub(p, out[out.length - 1]))
      if (dot(u, v) < 1 - 1e-9) break
      out.pop()
    }
    out.push([...p] as Vec3)
  }
  return out
}

/** A stack cable's tightest bend (m, before the model's scale): a recorded
 * cable's label naming one of the head's `min_bend_by_part` lengths takes
 * that, else the head's `min_bend_mm`, else the plain one. A derived link
 * names no length. */
export function stackBendM(
  a: CordEnd,
  b: CordEnd,
  link?: Pick<StackLink, "derived" | "label"> | null
): number {
  const label = link && !link.derived ? link.label : ""
  const mm = bendMm(a.cable, label) ?? bendMm(b.cable, label)
  return (mm ?? STACK_MIN_BEND_M * 1000) / 1000
}

/** A stack cable's jacket radius (m) in the room: the head's `cable:`
 * block's, else the plain one, at the model's scale. */
export function stackRadiusM(a: CordEnd, b: CordEnd): number {
  const mm = a.cable?.jacket_mm ?? b.cable?.jacket_mm ?? STACK_JACKET_MM
  return (mm / 2000) * (a.scale || 1)
}

/** A stack cable's cross-section, from the head's `cable:` block (the A
 * end's, else the B end's): one round jacket, or a zip cord's or ribbon's
 * jackets side by side along the heads' `cable` empties' ±X, `pitch`
 * apart (m, at the model's scale). No block: one plain round jacket. */
export type StackProfile =
  | { kind: "round"; radius: number }
  | {
      kind: "jackets"
      radius: number
      pitch: number
      count: number
      startUp: Vec3
      endUp: Vec3
    }

export function stackProfile(a: CordEnd, b: CordEnd): StackProfile {
  const radius = stackRadiusM(a, b)
  const drawn = runCable(a, b)
  const count = jacketCount(drawn?.cable)
  if (!drawn || count === 1) return { kind: "round", radius }
  const pitchMm = drawn.cable.pitch_mm ?? drawn.cable.jacket_mm
  return {
    kind: "jackets",
    radius,
    count,
    pitch: (pitchMm / 1000) * (a.scale || 1),
    startUp: a.y,
    endUp: b.y,
  }
}

// ── picking a cable ──────────────────────────────────────────────────────

/** A stack cable's key in a view: its two ends. */
export function stackLinkKey(link: Pick<StackLink, "a" | "b">): string {
  return `${link.a.device}:${link.a.name}>${link.b.device}:${link.b.name}`
}

/** A port's short name in the cable list: the name from its first digit
 * (`StackPort1/1` → `1/1`, `StackPower2/A` → `2/A`), else the name. */
export function shortPortName(name: string): string {
  const i = name.search(/\d/)
  return i > 0 ? name.slice(i) : name
}

/** A cable's line in the cable list: `1/1 → 2/2`. */
export function stackLinkLine(link: Pick<StackLink, "a" | "b">): string {
  return `${shortPortName(link.a.name)} → ${shortPortName(link.b.name)}`
}

export interface StackCableRow {
  key: string
  line: string
  link: StackLink
  stack: SceneStack
}

export interface StackCableGroup {
  kind: StackLinkKind
  /** `Stack` or `StackPower`, after the stack's name when a view draws
   * more than one stack. */
  title: string
  rows: StackCableRow[]
}

/** The cable list: each stack's cables, Stack then StackPower, in the
 * server's order; empty groups are left out. */
export function stackCableGroups(
  stacks: readonly SceneStack[]
): StackCableGroup[] {
  const out: StackCableGroup[] = []
  for (const s of stacks)
    for (const kind of ["data", "power"] as const) {
      const rows = s.links
        .filter((l) => (l.kind ?? "data") === kind)
        .map((link) => ({
          key: stackLinkKey(link),
          line: stackLinkLine(link),
          link,
          stack: s,
        }))
      if (!rows.length) continue
      const name = kind === "power" ? "StackPower" : "Stack"
      out.push({
        kind,
        title: stacks.length > 1 ? `${s.name} · ${name}` : name,
        rows,
      })
    }
  return out
}

/** The stack cable a port is an end of, or null: by the member and its
 * interface or power port name (or the port's anchor as drawn). */
export function linkAtPort(
  stacks: readonly SceneStack[],
  device: string,
  port: string
): StackLink | null {
  for (const s of stacks)
    for (const l of s.links)
      for (const e of [l.a, l.b])
        if (e.device === device && (e.name === port || e.port === port))
          return l
  return null
}

/** A member's name and the port, for a cable card's end line. */
export function linkEndText(
  stacks: readonly SceneStack[],
  end: StackLinkEnd
): string {
  for (const s of stacks) {
    const m = s.members.find((x) => x.device === end.device)
    if (m) return `${m.name} · ${end.name}`
  }
  return end.name
}

/**
 * Which stack cable a view highlights: the one picked (a click on it, its
 * head or one of its ports, or its row in the cable list) and the one a
 * list row's hover previews; the preview wins while it lasts. A plain
 * store - `subscribe` / `getVersion` fit `useSyncExternalStore`. It also
 * carries the view's stacks, so a toolbar outside the canvas can list
 * them.
 */
export class StackLinkStore {
  private picked: string | null = null
  private previewKey: string | null = null
  private drawn: readonly SceneStack[] = []
  private recordKeys: string[] | null = null
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  private bump() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  get selected(): string | null {
    return this.picked
  }

  get preview(): string | null {
    return this.previewKey
  }

  /** The cable drawn highlighted: the preview, else the picked one. */
  get active(): string | null {
    return this.previewKey ?? this.picked
  }

  get stacks(): readonly SceneStack[] {
    return this.drawn
  }

  /** The view's stacks as drawn; a picked cable no longer among them is
   * let go. */
  setStacks(stacks: readonly SceneStack[]) {
    if (stacks === this.drawn) return
    this.drawn = stacks
    const keys = new Set(stacks.flatMap((s) => s.links.map(stackLinkKey)))
    if (this.picked && !keys.has(this.picked)) this.picked = null
    if (this.previewKey && !keys.has(this.previewKey)) this.previewKey = null
    this.bump()
  }

  /** Pick `key`; picking the picked one again lets it go. */
  toggle(key: string) {
    this.picked = this.picked === key ? null : key
    this.bump()
  }

  /** Pick `key` (null: none), as a list row does. */
  select(key: string | null) {
    if (this.picked === key) return
    this.picked = key
    this.bump()
  }

  /** Pick the cable at a port, if it has one; true when it did. */
  selectPort(device: string, port: string): boolean {
    const l = linkAtPort(this.drawn, device, port)
    if (!l) return false
    this.select(stackLinkKey(l))
    return true
  }

  /** Pick, or put back, the cable at a port; true when it has one. */
  togglePort(device: string, port: string): boolean {
    const l = linkAtPort(this.drawn, device, port)
    if (!l) return false
    this.toggle(stackLinkKey(l))
    return true
  }

  /** Preview the cable at a port (its head hovered); null ends it. */
  previewPort(device: string, port: string | null) {
    const l = port ? linkAtPort(this.drawn, device, port) : null
    this.setPreview(l ? stackLinkKey(l) : null)
  }

  setPreview(key: string | null) {
    if (this.previewKey === key) return
    this.previewKey = key
    this.bump()
  }

  /** The derived cables Record cable is open for, or null. */
  get recording(): string[] | null {
    return this.recordKeys
  }

  /** Open Record cable for `keys` (null: close it). */
  record(keys: string[] | null) {
    this.recordKeys = keys && keys.length ? keys : null
    this.bump()
  }

  clear() {
    if (this.picked === null && this.previewKey === null) return
    this.picked = null
    this.previewKey = null
    this.bump()
  }

  /** How a cable draws: highlighted, ghosted behind a highlighted one, or
   * plain. */
  look(key: string): "active" | "dim" | null {
    const a = this.active
    if (!a) return null
    return a === key ? "active" : "dim"
  }
}

// ── recording a cable ────────────────────────────────────────────────────

/** A cable part number's length when its suffix says it plainly:
 * `STACK-T1-50CM` → 50 cm, `STACK-T1-1M` → 1 m, `CAB-SPWR-150CM` → 150 cm
 * (api.stack_cables.part_length); else null. */
export function partLength(
  part: string
): { length: number; unit: "m" | "cm" } | null {
  const m = /(?:^|[-_ ])(\d+(?:\.\d+)?)\s*(CM|M)=?$/i.exec(part.trim())
  if (!m) return null
  return {
    length: Number(m[1]),
    unit: m[2].toLowerCase() === "cm" ? "cm" : "m",
  }
}

/** A length in metres. */
export function lengthM(l: { length: number; unit: "m" | "cm" }): number {
  return l.unit === "cm" ? l.length / 100 : l.length
}

/** The lengths Record cable offers for a link: its head's part numbers
 * whose length reads, shortest first. */
export function partChoices(
  parts: readonly string[] | undefined
): { part: string; length: number; unit: "m" | "cm" }[] {
  const out: { part: string; length: number; unit: "m" | "cm" }[] = []
  for (const part of parts ?? []) {
    const l = partLength(part)
    if (l) out.push({ part, ...l })
  }
  return out.sort((x, y) => lengthM(x) - lengthM(y))
}

/** The cable a derived link records: its two ports, the part number as
 * the label with its length, `power` for a StackPower cable. */
export function recordPayload(
  link: Pick<StackLink, "a" | "b" | "kind">,
  choice: { part: string; length: string; unit: string }
): {
  a: { kind: "interface" | "power_port"; id: string }[]
  b: { kind: "interface" | "power_port"; id: string }[]
  label: string
  length: string | null
  length_unit: string
  type: string
} {
  const kind = link.kind === "power" ? "power_port" : "interface"
  return {
    a: [{ kind, id: link.a.id ?? "" }],
    b: [{ kind, id: link.b.id ?? "" }],
    label: choice.part.trim(),
    length: choice.length.trim() === "" ? null : choice.length.trim(),
    length_unit: choice.unit || "m",
    type: link.kind === "power" ? "stack-power" : "stack",
  }
}
