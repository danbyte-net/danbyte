import type {
  FlowRequirementPreview,
  RequirementAddress,
  RequirementEnd,
  RequirementEndKind,
  RequirementFamily,
  RequirementPairing,
  RequirementState,
} from "@/lib/api"

// Application flow requirements: how a requirement's state, ends and
// preview read, the same in the Requirements tab and the host strip.

export const REQUIREMENTS_ENDPOINT = "/api/application-flow-requirements/"

export const REQUIREMENT_STATE: Record<
  RequirementState,
  {
    label: string
    variant: "success" | "warning" | "destructive" | "outline" | "secondary"
  }
> = {
  resolved: { label: "Resolved", variant: "success" },
  partial: { label: "Partial", variant: "warning" },
  unresolved: { label: "Unresolved", variant: "destructive" },
  idle: { label: "Idle", variant: "outline" },
  pending: { label: "Pending", variant: "secondary" },
}

export const REQUIREMENT_END_KINDS: {
  value: RequirementEndKind
  label: string
}[] = [
  { value: "self", label: "This application" },
  { value: "app", label: "Hosts of application" },
  { value: "ip", label: "Address" },
  { value: "range", label: "Range" },
  { value: "prefix", label: "Prefix" },
  { value: "any", label: "Any" },
]

export const REQUIREMENT_ADDRESSES: {
  value: RequirementAddress
  label: string
}[] = [
  { value: "primary", label: "Primary address" },
  { value: "service", label: "Service address" },
  { value: "role", label: "Addresses with a role" },
  { value: "all", label: "Every address" },
]

export const REQUIREMENT_FAMILIES: {
  value: RequirementFamily
  label: string
}[] = [
  { value: "any", label: "Any" },
  { value: "ipv4", label: "IPv4" },
  { value: "ipv6", label: "IPv6" },
]

export const REQUIREMENT_PAIRINGS: {
  value: RequirementPairing
  label: string
}[] = [
  { value: "all", label: "Every host" },
  { value: "same_site", label: "Same site" },
]

/** Whether an end kind stands for hosts (and so takes an address mode). */
export const isHostEnd = (k: RequirementEndKind) => k === "self" || k === "app"

/** The address mode an end uses when none was picked. */
export const defaultAddress = (k: RequirementEndKind): RequirementAddress =>
  k === "self" ? "primary" : "service"

/** An end's sort and search text. */
export function requirementEndText(e: RequirementEnd): string {
  if (e.hidden) return "Hidden"
  return e.label
}

/** "Documents 96 flows on 48 hosts; 2 hosts have no address". */
export function previewText(p: FlowRequirementPreview): string {
  if (p.refused)
    return `Too many flows (over ${p.max.toLocaleString()}); narrow with pairing or address.`
  const flows = `${p.pairs.toLocaleString()} flow${p.pairs === 1 ? "" : "s"}`
  const hosts = `${p.hosts} host${p.hosts === 1 ? "" : "s"}`
  const gaps = p.gaps.length + p.hidden
  let out = `Documents ${flows} on ${hosts}`
  if (gaps)
    out += `; ${gaps} host${gaps === 1 ? " has" : "s have"} no usable address`
  if (p.state === "unresolved" || p.state === "idle") out += `. ${p.detail}`
  return out
}
