import type { DeviceLeds } from "@/lib/led-state"
import type { PortPlug } from "@/lib/port-plugs"
import type { StacksMode } from "@/lib/stacks-pref"
import {
  add,
  cordLead,
  len,
  mul,
  roundCorners,
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
}

export interface StackLink {
  a: StackLinkEnd
  b: StackLinkEnd
  /** Drawn from member order: no cable is recorded. */
  derived: boolean
  /** The recorded cable, or null. */
  cable: string | null
  color: string | null
  label: string
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
export function stackLinkText(link: Pick<StackLink, "derived">): string {
  return link.derived
    ? "Stack cable (derived from member order)"
    : "Stack cable"
}

// ── the run ──────────────────────────────────────────────────────────────

/** How far a stack cable bows out past its ends, as a share of their
 * distance, and at least this much (m). */
export const STACK_BOW = 0.35
export const STACK_BOW_MIN_M = 0.06
/** A plain stack cable's jacket (mm) when no head names one. */
export const STACK_JACKET_MM = 6
/** Its tightest bend (m) when no head names one. */
export const STACK_MIN_BEND_M = 0.03

/**
 * The run of one stack cable between its ends (the heads' `cable`
 * empties, or the port anchors when no head is drawn): each end's short
 * lead out along its +Z, then a loop bowed out further along the two
 * ends' mean out direction - a stack cable hangs out of the back of the
 * stack and turns round to the next member - its corners rounded. The
 * same ends give the same points.
 */
export function stackRunPoints(a: CordEnd, b: CordEnd): Vec3[] {
  const [a0, a1] = cordLead(a)
  const [b0, b1] = cordLead(b)
  const out = unit(add(unit(a.z), unit(b.z)))
  const dist = len(sub(b1, a1))
  const bow = Math.max(STACK_BOW_MIN_M, dist * STACK_BOW)
  const dir: Vec3 = len(out) > 1e-6 ? out : unit(a.z)
  const minBend =
    (a.cable?.min_bend_mm ?? b.cable?.min_bend_mm ?? STACK_MIN_BEND_M * 1000) /
    1000
  return roundCorners(
    [a0, a1, add(a1, mul(dir, bow)), add(b1, mul(dir, bow)), b1, b0],
    minBend * (a.scale || 1)
  )
}

/** A stack cable's jacket radius (m) in the room: the head's `cable:`
 * block's, else the plain one, at the model's scale. */
export function stackRadiusM(a: CordEnd, b: CordEnd): number {
  const mm = a.cable?.jacket_mm ?? b.cable?.jacket_mm ?? STACK_JACKET_MM
  return (mm / 2000) * (a.scale || 1)
}
