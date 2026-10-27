import type { ApplicationFlow, FlowEnd, FlowProtocol } from "@/lib/api"

// Application flows (#163): how a flow's protocol, ports and ends read, the
// same in tables, dialogs and the diagram.

export const FLOW_PROTOCOLS: { value: FlowProtocol; label: string }[] = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "tcp-udp", label: "TCP/UDP" },
  { value: "icmp", label: "ICMP" },
  { value: "any", label: "Any" },
]

const PROTOCOL_LABEL: Partial<Record<string, string>> = Object.fromEntries(
  FLOW_PROTOCOLS.map((p) => [p.value, p.label])
)

/** Protocols that carry no ports. */
export const PORTLESS_PROTOCOLS: ReadonlySet<FlowProtocol> = new Set([
  "icmp",
  "any",
])

/** "TCP 443", "UDP 53, 123", "ICMP", "Any". */
export function flowServiceLabel(
  f: Pick<ApplicationFlow, "protocol" | "ports">
): string {
  const proto = PROTOCOL_LABEL[f.protocol] ?? f.protocol.toUpperCase()
  return f.ports ? `${proto} ${f.ports}` : proto
}

/** The device or VM an end's address is assigned to, if any. */
export function endHost(e: FlowEnd): { id: string; name: string } | null {
  return e.device ?? e.vm ?? null
}

/** A stable key for an end: one node per address, range or prefix. "Any"
 * and a hidden end (#453) are their own end on each side. */
export function endKey(e: FlowEnd, side: "source" | "destination"): string {
  if (e.hidden) return `hidden:${side}`
  return e.kind === "any" ? `any:${side}` : `${e.kind}:${e.id}`
}
