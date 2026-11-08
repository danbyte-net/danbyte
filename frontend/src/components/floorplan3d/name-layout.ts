import type { Pt } from "@/components/floorplan/cable-route"
import {
  CLUSTER_FILL,
  CLUSTER_ICON,
  clusterNameOf,
} from "@/components/floorplan/icon-layout"
import {
  CALLOUT_MAX_LEADER,
  calloutClusters,
  layoutCallouts,
  segmentHitsBox,
} from "@/components/floorplan/plan-callouts"
import type { CalloutItem } from "@/components/floorplan/plan-callouts"
import { Occupancy, boxesHit } from "@/components/floorplan/plan-labels"
import type { Box } from "@/components/floorplan/plan-labels"
import { thinNames } from "@/components/floorplan/readable"
import type { NameCandidate } from "@/components/floorplan/readable"

// Readable names in the 3D room, laid out on screen each frame: a name
// plate sits over its object (its bottom centre on the anchor). Where
// plates would overlap - a row of racks from afar - the plain names thin
// as the 2D plan's do, and the crowd that lost a name is not left
// silently short: with Callouts on, every plate of that crowd goes in a
// box set off beside it with a leader back to its object (the 2D plan's
// callout layout, plan-callouts.ts); a crowd too big for that, or one
// whose boxes find no room near it, folds into one plate that names it
// as the 2D plan's cluster tiles do ("R-A01–R-A04", "7 racks"). Nothing
// placed ever covers another plate.

/** A name to place: its plate's size and anchor (screen px). */
export interface Name3D {
  id: string
  name: string
  kind: string
  icon: string
  color: string
  /** The plate's bottom centre (screen px). */
  x: number
  y: number
  w: number
  h: number
  /** Higher wins a clash. */
  priority: number
  /** Selected or hovered: always shown. */
  pinned?: boolean
}

export interface Summary3D {
  id: string
  name: string
  icon: string
  color: string
  members: string[]
  /** Its plate (screen px). */
  box: Box
}

export interface NameLayout3D {
  /** Shown over their own object. */
  plain: Set<string>
  /** Shown in a box off to the side: its plate and its leader (box edge,
   * object). */
  callouts: Map<string, { box: Box; leader: [Pt, Pt] }>
  /** Crowds named by one plate. */
  summaries: Summary3D[]
  /** The `extras` (the plan's own text) that show. */
  extras: Set<string>
}

/** A crowd bigger than this is summarised, not called out. */
export const MAX_CALLOUT_CROWD = 8
/** At most this many callouts a frame (a campus from afar): the crowds
 * past it are summarised. */
export const MAX_CALLOUTS = 96
/** Plates nearer than this (px) chain into one crowd. */
const JOIN_PX = 2
/** Air kept round a summary plate as it looks for room (px). */
const SUMMARY_GAP = 4

/** A plate's box over its anchor. */
export function plateBox(n: Pick<Name3D, "x" | "y" | "w" | "h">): Box {
  return { x: n.x - n.w / 2, y: n.y - n.h, w: n.w, h: n.h }
}

/**
 * Lay out the names. `callouts` false (Display > Callouts: Off) keeps
 * the plain thinning alone. `plateSize` measures a summary's plate.
 * `extras` - the plan's labels, area, zone and tray names (plan-text.ts) -
 * take part at their own priority: never moved, called out or summarised,
 * only shown or not, and the callouts and summaries keep off those shown.
 */
export function layoutNames3D(
  names: readonly Name3D[],
  opts: {
    view: Box
    callouts: boolean
    plateSize: (name: string, icon: string) => { w: number; h: number }
    extras?: readonly NameCandidate[]
  }
): NameLayout3D {
  const box = new Map(names.map((n) => [n.id, plateBox(n)]))
  const cand = (n: Name3D): NameCandidate => ({
    id: n.id,
    ...box.get(n.id)!,
    priority: n.pinned ? Infinity : n.priority,
  })
  const extras = opts.extras ?? []
  const first = thinNames([...names.map(cand), ...extras])
  const plain = new Set(names.filter((n) => first.has(n.id)).map((n) => n.id))
  const extrasKept = new Set(
    extras.filter((e) => first.has(e.id)).map((e) => e.id)
  )
  const thinned = new Set(plain)
  const out: NameLayout3D = {
    plain,
    callouts: new Map(),
    summaries: [],
    extras: extrasKept,
  }
  if (!opts.callouts || plain.size === names.length) return out

  // Crowds: plates touching, chained. Only those that lost a name change.
  const clusterOf = calloutClusters(
    names.map((n) => ({ id: n.id, box: box.get(n.id)! })),
    JOIN_PX
  )
  const crowds = new Map<number, Name3D[]>()
  for (const n of names) {
    const c = clusterOf.get(n.id)!
    const l = crowds.get(c)
    if (l) l.push(n)
    else crowds.set(c, [n])
  }
  const busy = [...crowds.values()].filter(
    (l) => l.length > 1 && l.some((n) => !plain.has(n.id))
  )
  if (!busy.length) return out
  const moved = new Set(busy.flat().map((n) => n.id))
  for (const id of moved) plain.delete(id)

  // What stays put: the plain names of the calm crowds.
  const fixed = new Occupancy(64)
  for (const n of names) if (plain.has(n.id)) fixed.add(box.get(n.id)!)
  for (const e of extras)
    if (extrasKept.has(e.id)) fixed.add({ x: e.x, y: e.y, w: e.w, h: e.h })

  const toSummary: Name3D[][] = []
  const items: CalloutItem[] = []
  busy.forEach((crowd, i) => {
    // Too big, or past what a frame lays out: one plate for it.
    if (
      crowd.length > MAX_CALLOUT_CROWD ||
      items.length + crowd.length > MAX_CALLOUTS
    ) {
      toSummary.push(crowd)
      return
    }
    // Round the crowd's anchors: its boxes go along its nearest side.
    const xs = crowd.map((n) => n.x)
    const ys = crowd.map((n) => n.y)
    const pad = 4
    const container = {
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
    }
    for (const n of crowd) {
      items.push({
        id: n.id,
        anchor: { x: n.x - 2, y: n.y - 2, w: 4, h: 4 },
        size: { w: n.w, h: n.h },
        group: `c:${String(i).padStart(6, "0")}`,
        container,
      })
    }
  })
  const placed = items.length
    ? layoutCallouts(items, {
        free: (b) => fixed.free(b),
        bounds: opts.view,
        maxLeader: CALLOUT_MAX_LEADER,
      })
    : new Map()
  // A crowd called out whole, or not at all: one left out folds the crowd
  // into its summary (its boxes free their place for it).
  for (const crowd of busy) {
    if (toSummary.includes(crowd)) continue
    if (crowd.every((n) => placed.has(n.id)))
      for (const n of crowd) {
        const p = placed.get(n.id)!
        out.callouts.set(n.id, { box: p.box, leader: p.leader })
      }
    else toSummary.push(crowd)
  }

  // Summaries: over the crowd's middle, up a step at a time until clear.
  const taken: Box[] = [...out.callouts.values()].map((c) => c.box)
  for (const crowd of toSummary) {
    // The selected or hovered keeps its own plate.
    const pinned = crowd.filter((n) => n.pinned)
    for (const n of pinned) {
      plain.add(n.id)
      taken.push(box.get(n.id)!)
    }
    const members = crowd.filter((n) => !n.pinned)
    if (!members.length) continue
    if (members.length === 1) {
      plain.add(members[0].id)
      continue
    }
    const icons = new Set(members.map((n) => n.icon))
    const colors = new Set(members.map((n) => n.color))
    const shared = icons.size === 1 && colors.size === 1
    const icon = shared ? members[0].icon : CLUSTER_ICON
    const color = shared ? members[0].color : CLUSTER_FILL
    const name = clusterNameOf(members)
    const size = opts.plateSize(name, icon)
    const cx = members.reduce((s, n) => s + n.x, 0) / members.length
    const top = Math.min(...members.map((n) => n.y))
    const clear = (b: Box) =>
      fixed.free(b) &&
      !taken.some((t) => boxesHit(t, b)) &&
      // Never over a callout's leader.
      ![...out.callouts.values()].some((c) =>
        segmentHitsBox(c.leader[0], c.leader[1], b)
      )
    let at: Box | null = null
    for (let k = 0; k <= 6 && !at; k++) {
      const b = {
        x: cx - size.w / 2,
        y: top - size.h - k * (size.h + SUMMARY_GAP),
        w: size.w,
        h: size.h,
      }
      if (clear(b)) at = b
    }
    if (!at) {
      // No room for it: the plain names that won, where still clear.
      for (const n of members) {
        const b = box.get(n.id)!
        if (thinned.has(n.id) && clear(b)) {
          plain.add(n.id)
          taken.push(b)
        }
      }
      continue
    }
    taken.push(at)
    out.summaries.push({
      id: `crowd:${members.map((n) => n.id).sort()[0]}`,
      name,
      icon,
      color,
      members: members.map((n) => n.id),
      box: at,
    })
  }

  // Last, whatever was placed: never one plate over another.
  const PLACED = 1e15
  const finals: NameCandidate[] = [
    ...out.summaries.map((s) => ({ id: s.id, ...s.box, priority: PLACED })),
    ...[...out.callouts].map(([id, c]) => ({
      id,
      ...c.box,
      priority: PLACED,
    })),
    ...names.filter((n) => plain.has(n.id)).map(cand),
    ...extras.filter((e) => extrasKept.has(e.id)),
  ]
  const kept = thinNames(finals)
  for (const id of [...extrasKept]) if (!kept.has(id)) extrasKept.delete(id)
  for (const id of [...plain]) if (!kept.has(id)) plain.delete(id)
  for (const id of [...out.callouts.keys()])
    if (!kept.has(id)) out.callouts.delete(id)
  out.summaries = out.summaries.filter((s) => kept.has(s.id))
  return out
}
