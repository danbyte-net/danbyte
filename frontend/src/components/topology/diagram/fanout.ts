import type { TopoEdge } from "@/lib/api"
import type { CablePair } from "./types"

// Breakout (fan-out) cables. A cable whose one end is a single port and
// whose other end lands on several - an MPO trunk broken out to four
// ports, a copper splitter - reaches the map as the cross product of its
// terminations: one payload edge per device pair it touches, each with a
// pair per port combination, all with the same cable id. Drawn as they
// come, that is several lines and several nubs for one physical port, with
// a bundle count on what is one cable.
//
// The Diagram draws it as the cable page does: one trunk out of the shared
// port to a split point (the junction), then one leg to each far port. A
// cable with several ports at both ends (N:M, an MPO trunk broken out at
// each end) is drawn the same way from both: each end's ports meet at a
// junction of their own, and one trunk joins the two junctions - when the
// payload says which cable end (A/B) each port is on. This module only
// finds them; build-diagram.ts turns each into junction nodes, a trunk
// edge and its legs.

/** One termination of a cable: a port on a node. */
export interface FanTerm {
  /** The React Flow node the port is on. */
  node: string
  port: string
  /** The component's id when the payload sends one. */
  id?: string
  /** A leg: the indexes into the fan's `raw.pairs` that reach it. */
  pairs?: number[]
}

export interface Fan {
  /** The junction node's id: `fan:<cable uuid>`. */
  id: string
  cable: string
  /** The cable's data with every pair of every edge it came as. */
  raw: NonNullable<TopoEdge["data"]>
  /** The one port the cable fans out from. */
  trunk: FanTerm
  /** Each far port, in payload order. */
  legs: FanTerm[]
  /** The payload edges it replaces. */
  edges: string[]
}

type Pair = CablePair

const termKey = (node: string, id: string | undefined, port: string) =>
  `${node}\u0000${id ?? `name:${port}`}`

/** A pair seen from its other end: every `a_` field traded with its `b_`
 * twin, the shared subnets' ends too. */
export function swapPair(p: Pair): Pair {
  const {
    a,
    b,
    a_port,
    b_port,
    a_id,
    b_id,
    a_kind,
    b_kind,
    a_end,
    b_end,
    a_ips,
    b_ips,
    subnets,
    ...rest
  } = p
  return {
    ...rest,
    a: b,
    b: a,
    ...(b_port !== undefined ? { a_port: b_port } : {}),
    ...(a_port !== undefined ? { b_port: a_port } : {}),
    ...(b_id !== undefined ? { a_id: b_id } : {}),
    ...(a_id !== undefined ? { b_id: a_id } : {}),
    ...(b_kind !== undefined ? { a_kind: b_kind } : {}),
    ...(a_kind !== undefined ? { b_kind: a_kind } : {}),
    ...(b_end !== undefined ? { a_end: b_end } : {}),
    ...(a_end !== undefined ? { b_end: a_end } : {}),
    ...(b_ips !== undefined ? { a_ips: b_ips } : {}),
    ...(a_ips !== undefined ? { b_ips: a_ips } : {}),
    ...(subnets
      ? {
          subnets: subnets.map(({ a_via, b_via, ...s }) => ({
            ...s,
            a: s.b,
            b: s.a,
            ...(b_via !== undefined ? { a_via: b_via } : {}),
            ...(a_via !== undefined ? { b_via: a_via } : {}),
          })),
        }
      : {}),
  }
}

/**
 * The breakout cables among a payload's edges: a cable with at least two
 * pairs whose every pair shares one termination. A cable with several
 * ports at both ends (N:M) is not one - it stays one line per pair. Only
 * edges whose ends are both on the map (`present`) count.
 */
export function detectFanouts(
  edges: readonly TopoEdge[],
  present: (id: string) => boolean
): Fan[] {
  const byCable = new Map<string, TopoEdge[]>()
  for (const e of edges) {
    if (e.type && e.type !== "cable") continue
    const cable = e.data?.cable_id
    if (!cable || !present(e.source) || !present(e.target)) continue
    const list = byCable.get(cable)
    if (list) list.push(e)
    else byCable.set(cable, [e])
  }
  const out: Fan[] = []
  for (const [cable, list] of byCable) {
    const pairs: { e: TopoEdge; p: Pair }[] = list.flatMap((e) =>
      (e.data?.pairs ?? []).map((p) => ({ e, p }))
    )
    if (pairs.length < 2) continue
    const terms = new Map<string, FanTerm & { n: number; first: number }>()
    const note = (node: string, id: string | undefined, port: string) => {
      const k = termKey(node, id, port)
      const t = terms.get(k)
      if (t) t.n += 1
      else
        terms.set(k, {
          node,
          port,
          ...(id ? { id } : {}),
          n: 1,
          first: terms.size,
        })
      return k
    }
    const keys = pairs.map(({ e, p }) => [
      note(e.source, p.a_id, p.a_port ?? p.a),
      note(e.target, p.b_id, p.b_port ?? p.b),
    ])
    const shared = [...terms.entries()].filter(([k]) =>
      keys.every(([a, b]) => a === k || b === k)
    )
    if (shared.length !== 1) continue
    const [trunkKey, trunk] = shared[0]
    const legs = [...terms.entries()]
      .filter(([k]) => k !== trunkKey)
      .sort((x, y) => x[1].first - y[1].first)
      .map(([k, t]) => ({
        node: t.node,
        port: t.port,
        ...(t.id ? { id: t.id } : {}),
        pairs: keys.flatMap(([a, b], i) => (a === k || b === k ? [i] : [])),
      }))
    if (legs.length < 2) continue
    const first = list[0].data!
    out.push({
      id: `fan:${cable}`,
      cable,
      // Every pair from the trunk's end, so a panel lists them alike.
      raw: {
        ...first,
        pairs: pairs.map(({ p }, i) =>
          keys[i][0] === trunkKey ? p : swapPair(p)
        ),
        lag: { a: null, b: null },
      },
      trunk: {
        node: trunk.node,
        port: trunk.port,
        ...(trunk.id ? { id: trunk.id } : {}),
      },
      legs,
      edges: list.map((e) => e.id),
    })
  }
  return out
}

/** A breakout with several ports at both ends: each end's ports meet at
 * a junction of their own, one trunk joins the junctions. */
export interface Mesh {
  /** The A end's junction node: `fan:<cable uuid>`; the B end's is
   * `fan:<cable uuid>:b`. */
  id: string
  cable: string
  /** The cable's data, every pair oriented from its A end. */
  raw: NonNullable<TopoEdge["data"]>
  /** The ports on the cable's A end and on its B end, in payload order;
   * each one's `pairs` index `raw.pairs`. */
  a: FanTerm[]
  b: FanTerm[]
  /** The payload edges it replaces. */
  edges: string[]
}

/**
 * The N:M breakout cables among a payload's edges: two or more ports at
 * both of the cable's ends, told apart by the ends (`a_end`/`b_end`) every
 * pair carries. Without them - an older server - there are none, and such
 * a cable stays one line per pair. `skip`: cables already drawn otherwise
 * (1:N breakouts).
 */
export function detectMeshes(
  edges: readonly TopoEdge[],
  present: (id: string) => boolean,
  skip: ReadonlySet<string> = new Set()
): Mesh[] {
  const byCable = new Map<string, TopoEdge[]>()
  for (const e of edges) {
    if (e.type && e.type !== "cable") continue
    const cable = e.data?.cable_id
    if (!cable || skip.has(cable)) continue
    if (!present(e.source) || !present(e.target)) continue
    const list = byCable.get(cable)
    if (list) list.push(e)
    else byCable.set(cable, [e])
  }
  const out: Mesh[] = []
  for (const [cable, list] of byCable) {
    // Every pair from the cable's A end.
    const pairs: { src: string; dst: string; p: Pair }[] = []
    let ends = true
    for (const e of list)
      for (const p0 of (e.data?.pairs ?? []) as Pair[]) {
        const known = (x?: string | null) => x === "A" || x === "B"
        if (!known(p0.a_end) || !known(p0.b_end) || p0.a_end === p0.b_end) {
          ends = false
          continue
        }
        pairs.push(
          p0.a_end === "A"
            ? { src: e.source, dst: e.target, p: p0 }
            : { src: e.target, dst: e.source, p: swapPair(p0) }
        )
      }
    if (!ends || pairs.length < 4) continue
    const terms = (side: "a" | "b") => {
      const seen = new Map<string, FanTerm & { first: number }>()
      pairs.forEach(({ src, dst, p }, i) => {
        const node = side === "a" ? src : dst
        const port = side === "a" ? (p.a_port ?? p.a) : (p.b_port ?? p.b)
        const id = side === "a" ? p.a_id : p.b_id
        const k = termKey(node, id, port)
        const t = seen.get(k)
        if (t) t.pairs!.push(i)
        else
          seen.set(k, {
            node,
            port,
            ...(id ? { id } : {}),
            pairs: [i],
            first: seen.size,
          })
      })
      return [...seen.values()]
        .sort((x, y) => x.first - y.first)
        .map(({ first: _first, ...t }) => t)
    }
    const a = terms("a")
    const b = terms("b")
    if (a.length < 2 || b.length < 2) continue
    const first = list[0].data!
    out.push({
      id: `fan:${cable}`,
      cable,
      raw: {
        ...first,
        pairs: pairs.map((x) => x.p),
        lag: { a: null, b: null },
      },
      a,
      b,
      edges: list.map((e) => e.id),
    })
  }
  return out
}

/** The trunk's middle label: the cable's label and type, e.g.
 * "TEST · cat5e". */
export function fanChip(raw: NonNullable<TopoEdge["data"]>): string[] {
  const text = [raw.cable_label, raw.cable_type].filter(Boolean).join(" · ")
  return text ? [text] : []
}
