import { api } from "@/lib/api"
import type {
  Paginated,
  Termination,
  TerminationInput,
  TerminationKind,
} from "@/lib/api"
import { byNatural } from "@/lib/natural-sort"

/** Cabling a run of ports (#454): one device's ports patched to another's in
 * order. These helpers are the pure part of "Save and add another" and of
 * the many-at-once pairing, kept here so both are testable without a form. */

export interface RunPort {
  id: string
  name: string
  cable?: { id: string } | null
}

/** A device's ports in natural order ("Gi1/0/2" before "Gi1/0/10"). */
export function naturalPorts<T extends RunPort>(ports: T[]): T[] {
  return [...ports].sort(byNatural((p) => p.name))
}

/** Ports without a cable, in natural order. A port only marked connected
 * stays free - the cable made here is the one the mark stood for. */
export function freePorts<T extends RunPort>(ports: T[]): T[] {
  return naturalPorts(ports).filter((p) => !p.cable)
}

/** After cabling `usedIds` on a device, the next `count` free ports after
 * the last of them in natural order - so Gi1/0/1 just cabled offers
 * Gi1/0/2. `exclude` keeps ports already picked elsewhere (the other end, on
 * the same device) out. Returns fewer than `count` when the device runs out,
 * and nothing when none of `usedIds` is on the list. */
export function nextFreePorts<T extends RunPort>(
  ports: T[],
  usedIds: string[],
  count: number = usedIds.length,
  exclude: ReadonlySet<string> = new Set()
): T[] {
  const sorted = naturalPorts(ports)
  const used = new Set(usedIds)
  let last = -1
  sorted.forEach((p, i) => {
    if (used.has(p.id)) last = i
  })
  if (last < 0) return []
  return sorted
    .slice(last + 1)
    .filter((p) => !p.cable && !used.has(p.id) && !exclude.has(p.id))
    .slice(0, count)
}

/** Positional pairing: the first ticked A port goes to the first ticked B
 * port, and so on. Leftovers on the longer side stay unpaired. */
export function pairPositionally<TLeft, TRight>(
  a: TLeft[],
  b: TRight[]
): { pairs: [TLeft, TRight][]; leftoverA: TLeft[]; leftoverB: TRight[] } {
  const n = Math.min(a.length, b.length)
  return {
    pairs: a.slice(0, n).map((x, i) => [x, b[i]] as [TLeft, TRight]),
    leftoverA: a.slice(n),
    leftoverB: b.slice(n),
  }
}

/** The list endpoint for each device-side port kind a cable end can pick. */
export const PORT_ENDPOINT: Record<
  Exclude<TerminationKind, "power_feed" | "circuit_termination">,
  string
> = {
  interface: "interfaces",
  front_port: "front-ports",
  rear_port: "rear-ports",
  console_port: "console-ports",
  console_server_port: "console-server-ports",
  power_port: "power-ports",
  power_outlet: "power-outlets",
  aux_port: "aux-ports",
}

/** The port-kind tabs a cable end offers, in the order they show. */
export const PORT_KIND_TABS: { value: string; label: string }[] = [
  { value: "interface", label: "Interfaces" },
  { value: "front_port", label: "Front" },
  { value: "rear_port", label: "Rear" },
  { value: "console_port", label: "Console" },
  { value: "power_port", label: "Power" },
  { value: "aux_port", label: "Aux" },
]

/** The endpoint for a kind, or null for an end that is not a device port. */
export function portEndpoint(kind: TerminationKind): string | null {
  return (PORT_ENDPOINT as Record<string, string>)[kind] ?? null
}

/** The ports to offer after cabling `terms` on one end: as many free ports
 * as were just used, next in natural order on the same device. An end that
 * isn't one kind on one device (a circuit, a feed, a breakout across hosts)
 * has no obvious "next", so it comes back empty, as does a device that has
 * run out of free ports. */
export async function advanceEnd(
  terms: Termination[],
  exclude: ReadonlySet<string> = new Set()
): Promise<TerminationInput[]> {
  const first = terms.at(0)
  if (!first) return []
  const endpoint = portEndpoint(first.kind)
  const deviceId = first.device.id
  if (
    !endpoint ||
    !deviceId ||
    terms.some((t) => t.kind !== first.kind || t.device.id !== deviceId)
  )
    return []
  const page = await api<Paginated<RunPort>>(
    `/api/${endpoint}/?device=${deviceId}&page_size=500`
  ).catch(() => null)
  if (!page) return []
  const next = nextFreePorts(
    page.results,
    terms.map((t) => t.id),
    terms.length,
    exclude
  )
  if (next.length !== terms.length) return []
  return next.map((p) => ({ kind: first.kind, id: p.id }))
}
