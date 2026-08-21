import { FormText } from "@/components/forms"
import type { ProtocolPorts, ServiceProtocol } from "@/lib/api"

/**
 * A service's ports, per protocol.
 *
 * Most services speak one protocol, but not all: DNS answers on TCP 53 *and*
 * UDP 53, and a service forced to pick one has to be entered twice under the
 * same name. There are exactly two protocols, so this is two fields rather
 * than a protocol picker plus a single port list - fewer controls, and the
 * thing you couldn't express before is now just filling in both.
 */

export interface ServicePortsValue {
  tcp: string
  udp: string
}

export function servicePortsFromApi(
  protocolPorts: ProtocolPorts | null | undefined,
  protocol: ServiceProtocol,
  ports: number[]
): ServicePortsValue {
  const map =
    protocolPorts && Object.keys(protocolPorts).length
      ? protocolPorts
      : { [protocol]: ports }
  return {
    tcp: (map.tcp ?? []).join(", "),
    udp: (map.udp ?? []).join(", "),
  }
}

export const EMPTY_SERVICE_PORTS: ServicePortsValue = { tcp: "", udp: "" }

function parseOne(input: string): { ports: number[]; invalid: string[] } {
  const seen = new Set<number>()
  const ports: number[] = []
  const invalid: string[] = []
  for (const tok of input.split(/[,\s]+/)) {
    if (tok === "") continue
    const n = Number(tok)
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      invalid.push(tok)
      continue
    }
    if (seen.has(n)) continue
    seen.add(n)
    ports.push(n)
  }
  return { ports, invalid }
}

export interface ParsedServicePorts {
  /** The map the API stores; empty when nothing valid was entered. */
  protocol_ports: ProtocolPorts
  /** First block, mirrored for the single-protocol fields every older reader
   * (and the API's required `ports`) still uses. */
  protocol: ServiceProtocol
  ports: number[]
  /** Per-field message, or null when that field is fine. */
  errors: { tcp: string | null; udp: string | null; form: string | null }
}

export function parseServicePorts(v: ServicePortsValue): ParsedServicePorts {
  const tcp = parseOne(v.tcp)
  const udp = parseOne(v.udp)
  const map: ProtocolPorts = {}
  if (tcp.ports.length) map.tcp = tcp.ports
  if (udp.ports.length) map.udp = udp.ports
  const first: ServiceProtocol = map.tcp ? "tcp" : "udp"
  const bad = (invalid: string[]) =>
    invalid.length ? `Not a valid port (1-65535): ${invalid.join(", ")}` : null
  return {
    protocol_ports: map,
    protocol: first,
    ports: map[first] ?? [],
    errors: {
      tcp: bad(tcp.invalid),
      udp: bad(udp.invalid),
      form:
        Object.keys(map).length === 0 && !tcp.invalid.length && !udp.invalid.length
          ? "Enter at least one port between 1 and 65535."
          : null,
    },
  }
}

export function ServicePortsField({
  value,
  onChange,
  errors,
}: {
  value: ServicePortsValue
  onChange: (v: ServicePortsValue) => void
  errors?: { tcp?: string | null; udp?: string | null }
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <FormText
        label="TCP ports"
        value={value.tcp}
        onChange={(v) => onChange({ ...value, tcp: v })}
        mono
        placeholder="443, 8443"
        hint="comma-separated"
        error={errors?.tcp ?? undefined}
      />
      <FormText
        label="UDP ports"
        value={value.udp}
        onChange={(v) => onChange({ ...value, udp: v })}
        mono
        placeholder="53"
        hint="comma-separated"
        error={errors?.udp ?? undefined}
      />
    </div>
  )
}

/** "TCP 443, 8443 · UDP 53" - one line naming every protocol a service
 * answers on, for tables and pickers. */
export function servicePortsLabel(
  protocolPorts: ProtocolPorts | null | undefined,
  protocol: ServiceProtocol,
  ports: number[]
): string {
  const map =
    protocolPorts && Object.keys(protocolPorts).length
      ? protocolPorts
      : { [protocol]: ports }
  return (["tcp", "udp"] as const)
    .filter((p) => (map[p] ?? []).length)
    .map((p) => `${p.toUpperCase()} ${(map[p] ?? []).join(", ")}`)
    .join(" · ")
}
