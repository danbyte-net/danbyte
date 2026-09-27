import type { TopoLinkSubnet, TopologyDiagramDisplay } from "@/lib/api"
import { swapPair } from "./fanout"
import type { CablePair, EndAddresses } from "./types"

// Link labels - the view's Labels setting. From the addresses the payload
// sends with each cable pair (`include=link_ips`):
//
// - `subnet`: the subnet the two ends of a cable share, as a chip on the
//   middle of its line; a dual-stack link shows both, stacked;
// - `ip`: each end's full address in that subnet, at that end;
// - `port`: the port names along the cables (Detailed).
//
// Only a subnet both ends sit in counts, and only a link-sized one: /24 or
// smaller (IPv4), /64 or smaller (IPv6). A larger shared subnet is a LAN,
// not the link. A pair without addresses (no `ipaddress.view`, or the
// addresses were not asked for) gives no label and no error. Pure.

/** A token of the Labels setting. */
export type LabelToken = TopologyDiagramDisplay["labels"][number]

/** What a view without a Labels setting shows. */
export const DEFAULT_LABELS: readonly LabelToken[] = ["subnet", "ip", "port"]

/** At most this many lines in a middle chip's subnet part, and in an end's
 * address block; past it, the last line counts the rest ("+2"). */
export const MID_MAX = 4
export const END_MAX = 3

/** Is `cidr` a link subnet: IPv4 /24 to /31, IPv6 /64 to /127? */
export function linkSubnet(cidr: string): boolean {
  const slash = cidr.lastIndexOf("/")
  if (slash < 0) return false
  const len = Number(cidr.slice(slash + 1))
  if (!Number.isInteger(len)) return false
  return cidr.includes(":") ? len >= 64 && len < 128 : len >= 24 && len < 32
}

/** A pair turned to the drawn edge: swapped when the edge was flipped hub
 * → leaf. */
export function orientPair(p: CablePair, flipped: boolean): CablePair {
  return flipped ? swapPair(p) : p
}

/** The link subnets a pair's two ends share, IPv4 first. */
function shared(p: CablePair): TopoLinkSubnet[] {
  const out = (p.subnets ?? []).filter(
    (s) =>
      typeof s.cidr === "string" &&
      typeof s.a === "string" &&
      typeof s.b === "string" &&
      linkSubnet(s.cidr)
  )
  return out.sort((x, y) => familyOf(x) - familyOf(y))
}

const familyOf = (s: Pick<TopoLinkSubnet, "cidr">) =>
  s.cidr.includes(":") ? 6 : 4

/** `list` cut to `max` lines, the last one counting what was cut. */
function cap(list: string[], max: number): string[] {
  return list.length <= max
    ? list
    : [...list.slice(0, max - 1), `+${list.length - max + 1}`]
}

/** Indexes `0..n-1` from the middle outwards: `n = 4` gives 2, 1, 3, 0. */
function middleOut(n: number): number[] {
  const m = Math.floor(n / 2)
  const out = [m]
  for (let k = 1; out.length < n; k++) {
    if (m - k >= 0) out.push(m - k)
    if (m + k < n) out.push(m + k)
  }
  return n ? out : []
}

const push = (list: string[], seen: Set<string>, v: string) => {
  if (seen.has(v)) return
  seen.add(v)
  list.push(v)
}

/** A link's labels: its middle chip's subnet lines and each drawn cable's
 * end addresses. */
export interface LinkLabelSet {
  /** Shared link subnets, IPv4 first, each once. */
  mid: string[]
  /** Per drawn cable: the addresses at each end. */
  ends: EndAddresses[]
}

/**
 * The labels of one drawn link. `cables` holds, per drawn cable (in anchor
 * order), the pairs it stands for, already oriented to the edge: one pair
 * per cable where each has its own nub (Detailed), all of them on the one
 * line of Simple. An address several cables share - a LAG's, on its
 * aggregate - is shown once, on the cable nearest the middle.
 */
export function linkLabelSet(
  cables: readonly (readonly CablePair[])[],
  tokens: readonly LabelToken[] = DEFAULT_LABELS
): LinkLabelSet {
  const wantMid = tokens.includes("subnet")
  const wantIp = tokens.includes("ip")
  const mids: TopoLinkSubnet[] = []
  const seenMid = new Set<string>()
  const per = cables.map((pairs) => {
    // Per family, so an end reads IPv4 first across all its pairs.
    const a: [string[], string[]] = [[], []]
    const b: [string[], string[]] = [[], []]
    const sa = new Set<string>()
    const sb = new Set<string>()
    for (const p of pairs)
      for (const s of shared(p)) {
        if (!seenMid.has(s.cidr)) {
          seenMid.add(s.cidr)
          mids.push(s)
        }
        const f = familyOf(s) === 6 ? 1 : 0
        push(a[f], sa, s.a)
        push(b[f], sb, s.b)
      }
    return { a: [...a[0], ...a[1]], b: [...b[0], ...b[1]] }
  })
  const ends: EndAddresses[] = cables.map(() => ({}))
  if (wantIp) {
    const shownA = new Set<string>()
    const shownB = new Set<string>()
    for (const i of middleOut(cables.length)) {
      const a = per[i].a.filter((x) => !shownA.has(x))
      const b = per[i].b.filter((x) => !shownB.has(x))
      for (const x of a) shownA.add(x)
      for (const x of b) shownB.add(x)
      ends[i] = {
        ...(a.length ? { a: cap(a, END_MAX) } : {}),
        ...(b.length ? { b: cap(b, END_MAX) } : {}),
      }
    }
  }
  const ordered = mids
    .map((s, i) => ({ s, i }))
    .sort((x, y) => familyOf(x.s) - familyOf(y.s) || x.i - y.i)
    .map(({ s }) => s.cidr)
  return { mid: wantMid ? cap(ordered, MID_MAX) : [], ends }
}

/** Does a set carry anything to draw? */
export function hasLabels(set: LinkLabelSet): boolean {
  return set.mid.length > 0 || set.ends.some((e) => !!(e.a || e.b))
}

/**
 * The labels of a breakout: per drawn leg (`legs`: the indexes into `pairs`
 * each stands for), the subnet and far address of that leg; on the trunk,
 * the shared port's addresses, each once. A subnet every leg shares goes on
 * the trunk once instead of on every leg. `pairs` are oriented from the
 * trunk.
 */
export function fanLabelSets(
  pairs: readonly CablePair[],
  legs: readonly (readonly number[])[],
  tokens: readonly LabelToken[] = DEFAULT_LABELS
): { trunk: LinkLabelSet; legs: LinkLabelSet[] } {
  const sets = legs.map((ids) => {
    const set = linkLabelSet([ids.map((i) => pairs[i]).filter(Boolean)], tokens)
    const b = set.ends[0]?.b
    return { mid: set.mid, ends: [b ? { b } : {}] }
  })
  const whole = linkLabelSet([pairs], tokens)
  const a = whole.ends[0]?.a
  const same =
    sets.length > 1 &&
    sets[0].mid.length > 0 &&
    sets.every((s) => s.mid.join("\n") === sets[0].mid.join("\n"))
  return {
    trunk: { mid: same ? sets[0].mid : [], ends: [a ? { a } : {}] },
    legs: same ? sets.map((s) => ({ ...s, mid: [] })) : sets,
  }
}
