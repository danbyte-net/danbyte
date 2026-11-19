// Cable ways through racks (docs/dcim/racks.md → Cable ways): the chain a
// cable page's Way card reads, its lengths, the reasons a proposal gives and
// the 0U channels a side-mounted device can sit in. The server works the
// ways out (`/api/cable-ways/summary/`); this only words them.

import type {
  CableWayExit,
  CableWayHop,
  CableWayProposal,
  ResolvedPathway,
} from "@/lib/api"

/** Why the engine proposed what it did (api/cable_way_engine.py). */
export const REASON_LABEL: Record<string, string> = {
  "side-left": "Port on the left",
  "side-right": "Port on the right",
  "side-guessed": "Port side unknown",
  "face-guessed": "Port face guessed",
  "other-side": "Other side's manager",
  "full-depth": "Full-depth manager",
  "crosses-depth": "Crosses front to rear",
  "horizontal-manager": "Horizontal manager",
  "pdu-channel": "PDU channel",
  "exit-overhead": "Overhead route",
  "exit-underfloor": "Underfloor route",
  "exit-default": "No room route",
  "exit-against-route": "No entry on the route's side",
  "no-vertical": "No vertical manager",
  "no-entry": "No entries",
  "same-rack": "Both ends here",
}

export function reasonText(code: string): string {
  return REASON_LABEL[code] ?? code
}

const EXIT_LABEL: Record<Exclude<CableWayExit, "">, string> = {
  port: "far port",
  top: "roof",
  bottom: "floor",
  side: "side panel",
}

/** A way as one readable chain: `Gi1/0/12 → Left rear → Roof → tray OH-A`.
 * The port leads; a way out names the tray it meets when known, a way
 * between two ports in one rack ends at the far port. */
export function wayChain(
  port: string,
  way: Pick<CableWayProposal, "hops" | "exit">,
  opts: { tray?: string | null; farPort?: string } = {}
): string {
  const parts = port ? [port] : []
  for (const h of way.hops) parts.push(h.label || h.key)
  const lastIsEntry = way.hops.at(-1)?.kind === "entry"
  if (way.exit === "port") parts.push(opts.farPort || EXIT_LABEL.port)
  else if (way.exit && !lastIsEntry) parts.push(EXIT_LABEL[way.exit])
  if (way.exit !== "port" && opts.tray) parts.push(`tray ${opts.tray}`)
  return parts.join(" → ")
}

/** A hop's units: `U40→U42` for a vertical run or channel, else "". */
export function hopUnits(h: Pick<CableWayHop, "enter_u" | "leave_u">) {
  if (h.enter_u == null) return ""
  if (h.leave_u == null || h.leave_u === h.enter_u) return `U${h.enter_u}`
  return `U${h.enter_u}→U${h.leave_u}`
}

/** A length in mm as people read it: `850 mm`, `1.25 m`. */
export function lengthText(mm: number | null | undefined): string {
  if (mm == null) return ""
  if (mm < 1000) return `${Math.round(mm)} mm`
  return `${(mm / 1000).toFixed(2).replace(/\.?0+$/, "")} m`
}

/** The pathways a hop may name: the rack's shown ones, in its order. */
export function hopOptions(items: ResolvedPathway[]) {
  return items
    .filter((p) => !p.hidden && !p.orphan)
    .map((p) => ({ value: p.key, label: p.label }))
}

/** The 0U channels a side-mounted device can sit in: the rack's shown ones
 * on its rail's side and, with a face, at that face. Values are keys, so
 * an inherited channel can be picked before it has a row. */
export function channelOptions(
  items: ResolvedPathway[],
  mount: "" | "side_left" | "side_right",
  face: "" | "front" | "rear"
) {
  if (!mount) return []
  const side = mount === "side_left" ? "left" : "right"
  return items
    .filter(
      (p) =>
        p.kind === "channel" &&
        !p.hidden &&
        !p.orphan &&
        p.side === side &&
        (!face || !p.face || p.face === face)
    )
    .map((p) => ({ value: p.key, label: p.label }))
}

/** The channel key a device's `mount_pathway` row stands for. */
export function channelKeyOf(
  items: ResolvedPathway[],
  pathwayId: string | null | undefined
): string {
  if (!pathwayId) return ""
  return items.find((p) => p.id === pathwayId)?.key ?? ""
}
