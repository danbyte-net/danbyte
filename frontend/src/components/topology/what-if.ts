import type { DependencyImpact, ImpactLevel, TopologyGraph } from "@/lib/api"

// "What if this fails?" on the Topology map (#450): the failed device and
// what goes down or loses redundancy with it, as rings on their cards; the
// rest of the map fades. The ring is the impact's colour - the same red and
// amber the impact lists use (components/monitoring/impact-levels.ts) - so a
// card reads as down or reduced at a glance.

/** A card's part in the what-if: the device that fails, or its level. */
export type ImpactMark = "root" | ImpactLevel

/** The ring a marked card wears. The failed device's is the thickest. */
export const IMPACT_RING: Record<ImpactMark, string> = {
  root: "outline-[3px] outline-offset-2 outline-destructive",
  outage: "outline-2 outline-offset-2 outline-destructive",
  reduced_redundancy:
    "outline-2 outline-offset-2 outline-dashed outline-amber-500",
}

export interface ImpactHighlight {
  /** Node id → its mark. A node not here is dimmed. */
  marks: Map<string, ImpactMark>
  /** Impacted devices with no card on this map. */
  offMap: number
}

/** The cards an impact marks on `graph`, by node id, and how many of the
 * impacted devices are not on it. */
export function impactHighlight(
  graph: Pick<TopologyGraph, "nodes">,
  rootDeviceId: string,
  impact: Pick<DependencyImpact, "devices">
): ImpactHighlight {
  const nodeOf = new Map<string, string>()
  for (const n of graph.nodes)
    if (n.data.device_id) nodeOf.set(n.data.device_id, n.id)
  const marks = new Map<string, ImpactMark>()
  const root = nodeOf.get(rootDeviceId)
  if (root) marks.set(root, "root")
  let offMap = 0
  for (const d of impact.devices) {
    const node = nodeOf.get(d.id)
    if (node) marks.set(node, d.level)
    else offMap += 1
  }
  return { marks, offMap }
}
