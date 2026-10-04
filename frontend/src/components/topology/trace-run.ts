import type { TopologyGraph, TraceGraph } from "@/lib/api"

// A trace map reads along its run, one end to the other: the devices in
// the order the run reaches them, so a patch panel sits between the two
// ends of the cable it carries - its front port facing one way, its rear
// port the other. The device map the trace sends (`device_graph`) says
// which cables are the run but not their order, and the Diagram on its own
// ranks by hub → leaf, which put a panel with both ends cabled at one edge
// and ran the run back past itself.

/** The port-level trace's wiring: each port and the ports its cables and
 * pass-throughs reach. */
function wiring(trace: TraceGraph): Map<string, string[]> {
  const adj = new Map<string, string[]>()
  const link = (a: string, b: string) => {
    const l = adj.get(a)
    if (l) l.push(b)
    else adj.set(a, [b])
  }
  for (const e of trace.edges) {
    if (e.type !== "cable" && e.type !== "through") continue
    link(e.source, e.target)
    link(e.target, e.source)
  }
  return adj
}

/**
 * Each traced device's place along the run (0 at the end it starts from),
 * keyed by its card on the device map (`dev:<id>`). The run starts at the
 * traced port; a cable's trace starts at the first end of the run the
 * payload lists. A device the run passes twice keeps its first place.
 */
export function runOrder(trace: TraceGraph): Record<string, number> {
  const adj = wiring(trace)
  const ports = trace.nodes.filter((n) => n.type !== "device")
  const origin = ports.find((n) => n.id.endsWith(`:${trace.origin.id}`))
  const end = ports.find((n) => (adj.get(n.id)?.length ?? 0) <= 1)
  const start = (origin ?? end ?? ports.at(0))?.id
  if (!start) return {}
  const dist = new Map([[start, 0]])
  const queue = [start]
  // The queue grows as it is walked: each port once, nearest first.
  for (const at of queue) {
    for (const next of adj.get(at) ?? []) {
      if (dist.has(next)) continue
      dist.set(next, dist.get(at)! + 1)
      queue.push(next)
    }
  }
  const first = new Map<string, number>()
  for (const n of ports) {
    const d = dist.get(n.id)
    const dev = n.data.device_id
    if (d === undefined || !dev) continue
    const key = `dev:${dev}`
    first.set(key, Math.min(first.get(key) ?? d, d))
  }
  // Places, not hops: a panel's front and rear port count once.
  const steps = [...new Set(first.values())].sort((a, b) => a - b)
  return Object.fromEntries(
    [...first].map(([key, d]) => [key, steps.indexOf(d)])
  )
}

/** A card on the device map that is a patch panel. */
function isPanel(n: TopologyGraph["nodes"][number]): boolean {
  return !!(n.data.panel || n.data.role?.is_patch_panel)
}

/**
 * The trace's device map as the trace section draws it: a patch panel's
 * other cables are left out, so its card has a nub on each front and rear
 * port the run uses and nothing else. The cables between other traced
 * devices stay, drawn thin beside the run.
 */
export function traceMap(trace: TraceGraph): TopologyGraph | undefined {
  const g = trace.device_graph
  if (!g) return undefined
  const panels = new Set(g.nodes.filter(isPanel).map((n) => n.id))
  if (!panels.size) return g
  const edges = g.edges.filter(
    (e) =>
      e.type !== "cable" ||
      !!e.data?.marked ||
      !(panels.has(e.source) || panels.has(e.target))
  )
  return edges.length === g.edges.length ? g : { ...g, edges }
}
