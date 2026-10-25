import type { QueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import type {
  ComplianceRule,
  ComplianceSeverity,
  ComplianceTriageState,
} from "@/lib/api"
import { cn } from "@/lib/utils"

/** A rule's severity → its Badge variant. One badge per severity. */
export const SEV_VARIANT: Record<
  ComplianceSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

export const SEVERITIES: ComplianceSeverity[] = ["critical", "warning", "info"]

export const SEVERITY_RANK: Record<ComplianceSeverity, number> = {
  critical: 3,
  warning: 2,
  info: 1,
}

export const SEVERITY_LABEL: Record<ComplianceSeverity, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
}

/** The synthetic rule IaC config drift reports under. */
export const CONFIG_DRIFT_RULE_ID = "config-drift"

export const OBJ_ROUTE: Record<string, string> = {
  prefix: "/prefixes/$id",
  ipaddress: "/ips/$id",
  device: "/devices/$id",
  vlan: "/vlans/$id",
  vrf: "/vrfs/$id",
  site: "/sites/$id",
  virtualmachine: "/virtual-machines/$id",
}

const PLURAL: Record<string, [string, string]> = {
  prefix: ["prefix", "prefixes"],
  ipaddress: ["IP address", "IP addresses"],
  device: ["device", "devices"],
  vlan: ["VLAN", "VLANs"],
  vrf: ["VRF", "VRFs"],
  site: ["site", "sites"],
  virtualmachine: ["virtual machine", "virtual machines"],
}

/** "3 devices", "1 IP address" - a count of one object type. */
export function countOf(objectType: string, n: number): string {
  const [one, many] = PLURAL[objectType] ?? ["object", "objects"]
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function SeverityBadge({
  severity,
  className,
}: {
  severity: ComplianceSeverity
  className?: string
}) {
  return (
    <Badge variant={SEV_VARIANT[severity]} className={className}>
      {SEVERITY_LABEL[severity]}
    </Badge>
  )
}

/** A violation's triage state. Open is the default and carries no badge in
 * dense rows unless `showOpen` asks for one. */
export function TriageBadge({
  state,
  showOpen,
  className,
}: {
  state: ComplianceTriageState | undefined
  showOpen?: boolean
  className?: string
}) {
  if (!state || state === "open")
    return showOpen ? (
      <Badge variant="outline" className={className}>
        Open
      </Badge>
    ) : null
  return (
    <Badge variant="secondary" className={cn(className)}>
      {state === "acknowledged" ? "Acknowledged" : "Snoozed"}
    </Badge>
  )
}

export function ruleSummary(
  r: Pick<ComplianceRule, "field" | "pattern" | "tag" | "cf_key"> & {
    eol_fail_on?: string
    coverage_fail_on?: string
    fail_on_unknown?: boolean
    check_type: string
    check_type_display?: string
  }
): string {
  switch (r.check_type) {
    case "required":
      return `${r.field} must be set`
    case "forbidden":
      return `${r.field} must be empty`
    case "regex":
      return `${r.field} ~ /${r.pattern}/`
    case "required_tag":
      return `must have tag “${r.tag}”`
    case "required_cf":
      return `cf “${r.cf_key}” must be set`
    case "eol_status":
      return r.eol_fail_on === "unknown"
        ? "platform must have end-of-life data"
        : r.eol_fail_on === "ending"
          ? "platform support must not be ending"
          : "platform must not be end of life"
    case "coverage": {
      const scope = r.tag ? `devices tagged “${r.tag}”` : "devices"
      return r.coverage_fail_on === "expiring"
        ? `${scope} must have coverage beyond the warning window`
        : `${scope} must have active coverage`
    }
    case "software_target":
      return r.fail_on_unknown
        ? "version must be the platform target, and known"
        : "version must be the platform target"
    default:
      return r.check_type_display ?? r.check_type
  }
}

/** Every query that shows a violation's state or a rule's counts. */
export function invalidateCompliance(qc: QueryClient) {
  for (const key of [
    "compliance-eval",
    "compliance-evaluate",
    "compliance-summary",
    "compliance-rule-violations",
  ])
    void qc.invalidateQueries({ queryKey: [key] })
}
