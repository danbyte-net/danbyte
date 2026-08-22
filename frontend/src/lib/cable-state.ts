// The port-utilization vocabulary, derived per port row - one definition for
// the card, the faceplate glow, and the components-tab filters.

export type CableState = "free" | "connected" | "reserved" | "marked"

export const CABLE_STATES: CableState[] = [
  "connected",
  "reserved",
  "marked",
  "free",
]

export const CABLE_STATE_LABEL: Record<CableState, string> = {
  connected: "Connected",
  reserved: "Reserved",
  marked: "Undocumented",
  free: "Free",
}

/** Does a port's state satisfy a filter/glow selection? "Connected" is a
 * superset: it includes undocumented (marked) ports, matching the card's
 * connected count; "Undocumented" selects just that subset. */
export function cableStateMatches(
  state: CableState,
  filter: CableState
): boolean {
  return state === filter || (filter === "connected" && state === "marked")
}

/** free | connected | reserved | marked for any port-ish row that carries the
 * cable summary (+ optional mark_connected / reservation). Reserved = the
 * cable's status is the Planned catalog entry, or the uncabled port holds a
 * direct PortReservation; a real cable (or mark_connected) outranks the hold. */
export function cableState(p: {
  cable?: { status?: { slug?: string } | null } | null
  mark_connected?: boolean
  reservation?: { id: string } | null
}): CableState {
  if (p.cable)
    return p.cable.status?.slug === "planned" ? "reserved" : "connected"
  if (p.mark_connected) return "marked"
  return p.reservation ? "reserved" : "free"
}
