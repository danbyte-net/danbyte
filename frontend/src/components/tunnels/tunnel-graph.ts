import type {
  StatusMini,
  TopoEdge,
  TopoNode,
  TopologyGraph,
  Tunnel,
  TunnelTermination,
} from "@/lib/api"
import { withCardLines } from "@/components/topology/diagram/card-fields"

// A tunnel as the Diagram draws it (topology/embedded-map.tsx). Each end is
// a card: the device's own - its role's colour and card lines, as the
// Topology API sends them - or a neutral one for a VM. The end's role
// (Hub, Spoke, Peer) is the card's pill. Each hub ↔ spoke and peer ↔ peer
// is one dashed line, its interface name and outside address on the line
// at each end.
//
// A hub's one tunnel interface reaches every spoke, the way one port of a
// breakout cable reaches its far ports: its links share the hub end's id
// where a cable's id goes, so the Diagram draws them as it draws a
// breakout - one nub, a trunk to a junction, a leg to each spoke. Pure.

/** A card's data here: a VM's card carries the VM, for its page. */
export type TunnelCardData = TopoNode["data"] & { vm_id?: string }

/** What the tunnel map draws. */
export interface TunnelMapModel {
  graph: TopologyGraph
  /** Hub-and-spoke reads top to bottom, hubs first; peers side by side. */
  direction: "LR" | "TB"
  /** Three peers or more: their cards' centres on a ring, pinned - a
   * layered layout draws a full mesh as a tangled column. */
  positions?: Record<string, [number, number]>
}

/** The room each card on a ring takes along it: a card and the port
 * names and addresses at both ends of a line to its neighbour. */
const RING_STEP = 440
const RING_MIN = 260

/** Centres round a ring, the first at the top, going clockwise. */
export function ringPositions(
  ids: readonly string[]
): Record<string, [number, number]> {
  const r = Math.max(RING_MIN, (ids.length * RING_STEP) / (2 * Math.PI))
  const out: Record<string, [number, number]> = {}
  ids.forEach((id, i) => {
    const a = (2 * Math.PI * i) / ids.length - Math.PI / 2
    out[id] = [Math.round(r * Math.cos(a)), Math.round(r * Math.sin(a))]
  })
  return out
}

/** The card an end is drawn on: its device's, or its VM's. */
export function endNodeId(t: TunnelTermination): string {
  if (t.interface) return `dev:${t.interface.device.id}`
  return `vm:${t.vm_interface?.vm.id ?? t.id}`
}

/** The devices the tunnel ends on, sorted: whose cards to ask for. */
export function tunnelDeviceIds(tunnel: Pick<Tunnel, "terminations">) {
  const ids = new Set<string>()
  for (const t of tunnel.terminations)
    if (t.interface) ids.add(t.interface.device.id)
  return [...ids].sort()
}

/** The pill an end's card wears: its role, in the neutral badge a status
 * without a colour draws as - on screen and in every exported file. */
function rolePill(name: string): StatusMini {
  return { id: "", name, color: "", text_color: "" }
}

/** A card's data with the role pill first in its lines. */
function withRole(data: TopoNode["data"], role: string): TopoNode["data"] {
  const shown = withCardLines(data)
  const card = shown.card!
  return {
    ...shown,
    status_mini: rolePill(role),
    card: {
      ...card,
      fields: card.fields.includes("status")
        ? card.fields
        : ["status", ...card.fields],
    },
  }
}

function endCard(
  t: TunnelTermination,
  role: string,
  cards: ReadonlyMap<string, TopoNode>
): TopoNode {
  const id = endNodeId(t)
  if (t.interface) {
    const dev = t.interface.device
    // Out of the viewer's scope, or no card from the API: the name alone.
    const own = cards.get(id)
    return {
      id,
      type: "device",
      data: withRole(own?.data ?? { name: dev.name, device_id: dev.id }, role),
    }
  }
  const vm = t.vm_interface?.vm
  const data: TunnelCardData = {
    name: vm?.name ?? "-",
    device_type: "Virtual machine",
    status_mini: rolePill(role),
    card: { fields: ["status", "device_type"], source: "default", values: {} },
    ...(vm ? { vm_id: vm.id } : {}),
  }
  return { id, type: "device", data }
}

const portOf = (t: TunnelTermination) =>
  t.interface?.name ?? t.vm_interface?.name ?? "-"
const endName = (t: TunnelTermination) =>
  t.interface?.device.name ?? t.vm_interface?.vm.name ?? "-"

/** One tunnel link between two ends. `fan`: the hub end its links share. */
function tunnelLink(
  tunnel: Pick<Tunnel, "id" | "name">,
  a: TunnelTermination,
  b: TunnelTermination,
  fan?: string
): TopoEdge {
  return {
    id: `tun:${a.id}:${b.id}`,
    source: endNodeId(a),
    target: endNodeId(b),
    data: {
      ...(fan ? { cable_id: fan } : {}),
      // What the line's hover names first, as a cable's label.
      cable_label: tunnel.name,
      tunnel: { id: tunnel.id, name: tunnel.name },
      pairs: [
        {
          a: `${endName(a)}:${portOf(a)}`,
          b: `${endName(b)}:${portOf(b)}`,
          a_port: portOf(a),
          b_port: portOf(b),
          a_id: a.interface?.id ?? a.vm_interface?.id,
          a_kind: a.interface ? "interface" : "vminterface",
          b_id: b.interface?.id ?? b.vm_interface?.id,
          b_kind: b.interface ? "interface" : "vminterface",
          a_outside: a.outside_ip?.ip_address ?? null,
          b_outside: b.outside_ip?.ip_address ?? null,
        },
      ],
    },
  }
}

/**
 * The tunnel's map. Hub-and-spoke: a line from every hub to every other
 * end. No hub (or nothing but hubs): every end to every other - two peers
 * are one line, three or more a ring. `cards` is the Topology API's answer for the tunnel's
 * devices (`include=card`); without it the device cards show their name.
 */
export function tunnelGraph(
  tunnel: Pick<Tunnel, "id" | "name" | "terminations">,
  cards?: TopologyGraph | null
): TunnelMapModel {
  const ends = tunnel.terminations
  const hubs = ends.filter((t) => t.role === "hub")
  const rest = ends.filter((t) => t.role !== "hub")
  const spoked = hubs.length > 0 && rest.length > 0

  // One card per device or VM; an end sharing one with another end adds
  // its role to the pill.
  const roles = new Map<string, string[]>()
  const first = new Map<string, TunnelTermination>()
  for (const t of spoked ? [...hubs, ...rest] : ends) {
    const id = endNodeId(t)
    const list = roles.get(id) ?? []
    if (!list.includes(t.role_display)) list.push(t.role_display)
    roles.set(id, list)
    if (!first.has(id)) first.set(id, t)
  }
  const byId = new Map((cards?.nodes ?? []).map((n) => [n.id, n]))
  const nodes = [...first].map(([id, t]) =>
    endCard(t, roles.get(id)!.join(" · "), byId)
  )

  const edges: TopoEdge[] = []
  const add = (a: TunnelTermination, b: TunnelTermination, fan?: string) => {
    if (endNodeId(a) !== endNodeId(b)) edges.push(tunnelLink(tunnel, a, b, fan))
  }
  if (spoked) {
    for (const h of hubs)
      for (const s of rest) add(h, s, rest.length > 1 ? h.id : undefined)
  } else {
    for (let i = 0; i < ends.length; i++)
      for (let j = i + 1; j < ends.length; j++) add(ends[i], ends[j])
  }
  return {
    graph: {
      nodes,
      edges,
      ...(cards?.meta ? { meta: cards.meta } : {}),
    },
    direction: spoked ? "TB" : "LR",
    ...(!spoked && nodes.length > 2
      ? { positions: ringPositions(nodes.map((n) => n.id)) }
      : {}),
  }
}
