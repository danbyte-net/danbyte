import type {
  TopoClusterCard,
  TopoEdge,
  TopoNode,
  TopologyGraph,
} from "@/lib/api"

// Clusters on the topology (#517, Display ▸ Group clusters): the hosts of a
// cluster drawn as one card - the cluster's name and its host count - with
// their cables folded into one line per far card, counted, the way a group
// map counts the cables between two sites. A cluster opened on the view
// (`state.chassis[<id>].open`) keeps its hosts, stacked in a frame round
// them like a virtual chassis' members (diagram/chassis.ts). The card and
// the frame share one node id (`cl:<cluster id>`), so either stands where
// the other did.
//
// The server says which nodes are hosts and counts each cluster's cables
// per far node (`group_clusters`, api/topology_views.py); here two shut
// clusters' rows meet in one line, and the lines the page lays over the
// cables (LLDP, BGP, dependencies, circuits) move onto the card.

/** The card line a cluster's card shows (diagram/card-fields.ts). */
export const HOSTS_LINE = "hosts"

/** "5 hosts". */
export const hostsText = (n: number) => `${n} ${n === 1 ? "host" : "hosts"}`

/** A cluster drawn as one card, from a node's data. */
export function clusterCardOf(data: unknown): TopoClusterCard | undefined {
  const c = (data as { cluster_card?: unknown } | null | undefined)
    ?.cluster_card
  return c &&
    typeof c === "object" &&
    typeof (c as TopoClusterCard).id === "string"
    ? (c as TopoClusterCard)
    : undefined
}

/** The one value every member shares, or undefined. */
function shared<T>(xs: readonly T[], key: (x: T) => string | undefined) {
  const first = xs.length ? key(xs[0]) : undefined
  return first !== undefined && xs.every((x) => key(x) === first)
    ? xs[0]
    : undefined
}

/**
 * `graph` with every cluster that has two hosts or more on it, and is not
 * in `open`, drawn as one card. Cables between its hosts go (the card's
 * `inner` counts them); cables to the rest become one `group` line per far
 * card (`cable_count`, the cable types); other lines move to the card, and
 * go when both their ends are on it. Without `clusters` it is `graph`.
 */
export function collapseClusters(
  graph: TopologyGraph,
  open: ReadonlySet<string>
): TopologyGraph {
  const clusters = graph.clusters ?? []
  if (!clusters.length) return graph
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const cardOf = new Map<string, string>()
  const cards: TopoNode[] = []
  const shut: typeof clusters = []
  for (const c of clusters) {
    if (open.has(c.id)) continue
    const members = c.members.flatMap((m) => {
      const n = byId.get(m)
      return n ? [n] : []
    })
    if (members.length < 2) continue
    for (const m of members) cardOf.set(m.id, c.frame)
    shut.push(c)
    // A card stands where its hosts did: their role when they share one
    // (a Levels tier, a band), their site and location likewise.
    const role = shared(members, (m) => m.data.role?.id ?? m.data.role?.name)
    const site = shared(members, (m) => m.data.site ?? undefined)
    const location = shared(members, (m) => m.data.location ?? undefined)
    const card: TopoClusterCard = {
      id: c.id,
      name: c.name,
      member_count: members.length,
      members: members.map((m) => m.data.name),
      inner: c.inner,
    }
    cards.push({
      id: c.frame,
      type: "device",
      data: {
        name: c.name,
        role: role?.data.role ?? null,
        site: site?.data.site ?? null,
        location: location?.data.location ?? null,
        ports: [],
        card: { fields: [HOSTS_LINE], source: "default", values: {} },
        cluster_card: card,
      },
    })
  }
  if (!cards.length) return graph

  const edgeById = new Map(graph.edges.map((e) => [e.id, e]))
  const folded = new Set<string>()
  const lines = new Map<
    string,
    { source: string; target: string; edges: Set<string> }
  >()
  for (const c of shut) {
    for (const row of c.links) {
      const far = cardOf.get(row.node) ?? row.node
      if (far === c.frame) continue
      const [a, b] = c.frame < far ? [c.frame, far] : [far, c.frame]
      const key = `${a}|${b}`
      const line = lines.get(key) ?? {
        source: c.frame,
        target: far,
        edges: new Set<string>(),
      }
      // Only the cables still on the map: hiding a line or its far card
      // takes it out of the count.
      for (const id of row.edges) {
        if (!edgeById.has(id)) continue
        line.edges.add(id)
        folded.add(id)
      }
      if (line.edges.size) lines.set(key, line)
    }
  }

  const edges: TopoEdge[] = []
  for (const e of graph.edges) {
    if (folded.has(e.id)) continue
    const s = cardOf.get(e.source) ?? e.source
    const t = cardOf.get(e.target) ?? e.target
    if (s === e.source && t === e.target) {
      edges.push(e)
      continue
    }
    // Both ends on one card: a cable between its hosts, or any line.
    if (s === t) continue
    edges.push({ ...e, source: s, target: t })
  }
  for (const line of lines.values()) {
    const types = new Set<string>()
    for (const id of line.edges) {
      const t = edgeById.get(id)?.data?.cable_type
      if (t) types.add(t)
    }
    edges.push({
      id: `cle:${line.source}:${line.target}`,
      source: line.source,
      target: line.target,
      type: "group",
      data: {
        cable_count: line.edges.size,
        types: [...types].sort(),
        cluster_edges: [...line.edges],
      } as unknown as TopoEdge["data"],
    })
  }
  return {
    ...graph,
    nodes: [...graph.nodes.filter((n) => !cardOf.has(n.id)), ...cards],
    edges,
  }
}
