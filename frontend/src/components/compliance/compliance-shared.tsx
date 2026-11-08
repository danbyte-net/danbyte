import type { QueryClient } from "@tanstack/react-query"

import { Badge } from "@/components/ui/badge"
import type {
  ComplianceExpr,
  ComplianceRef,
  ComplianceRule,
  ComplianceSeverity,
  ComplianceTriageState,
} from "@/lib/api"
import { isListExpr } from "@/lib/filter-expr"
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

/** "12 devices, 3 virtual machines" - a rule's failures per object type,
 * the types with none left out (all of them when nothing fails). */
export function countByType(byType: Record<string, number>): string {
  const entries = Object.entries(byType)
  const failing = entries.filter(([, n]) => n > 0)
  return (failing.length ? failing : entries.slice(0, 1))
    .map(([t, n]) => countOf(t, n))
    .join(", ")
}

/** The object types a rule applies to, as one line ("Device, Virtual
 * machine"). */
export function typesLabel(types: string[]): string {
  return types.map((t) => OBJECT_TYPE_LABEL[t] ?? t).join(", ")
}

/** An object type's label, or the key itself for one this page lacks. */
export function typeName(t: string): string {
  return (OBJECT_TYPE_LABEL as Record<string, string | undefined>)[t] ?? t
}

export const OBJECT_TYPE_LABEL: Record<string, string> = {
  prefix: "Prefix",
  ipaddress: "IP address",
  device: "Device",
  vlan: "VLAN",
  vrf: "VRF",
  site: "Site",
  virtualmachine: "Virtual machine",
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

const SCALAR_WORDS: Record<string, string> = {
  "=": "is",
  "!=": "is not",
  "~": "contains",
  "!~": "lacks",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
}

function fieldWord(key: string): string {
  if (key.startsWith("cf.")) return key.slice(3)
  if (key === "type") return "type"
  return key.replace(/_/g, " ")
}

/** A scope or conditions in a few words: "role is Server and owner set".
 * Catalog rows read by name from the rule's `refs`. */
export function exprSummary(
  e: ComplianceExpr | null | undefined,
  refs: Record<string, ComplianceRef> = {},
  parent?: "and" | "or"
): string {
  if (!e) return ""
  if (e.kind === "group") {
    const inner = e.terms
      .map((t) => exprSummary(t, refs, e.op))
      .join(` ${e.op} `)
    return parent && parent !== e.op ? `(${inner})` : inner
  }
  const label = fieldWord(e.field)
  if (e.kind === "empty") return `${label} ${e.negated ? "set" : "empty"}`
  if (isListExpr(e)) {
    const names = e.values.map((v) => {
      const ref = refs[v] as ComplianceRef | undefined
      if (!ref) return OBJECT_TYPE_LABEL[v] ?? v
      if (ref.hidden) return "hidden"
      if (ref.missing) return "deleted"
      return ref.name ?? v
    })
    const list = names.join(e.cmp === "in" ? " or " : " nor ")
    if (e.field === "tags")
      return `${e.cmp === "in" ? "tag" : "no tag"} ${list}`
    return `${label} ${e.cmp === "in" ? "is" : "is not"} ${list}`
  }
  const scalar = e
  if (scalar.cmp === "matches") return `${label} ~ /${scalar.value}/`
  if (scalar.cmp === "not_matches") return `${label} !~ /${scalar.value}/`
  return `${label} ${SCALAR_WORDS[scalar.cmp] ?? scalar.cmp} ${scalar.value}`
}

export function ruleSummary(
  r: Pick<ComplianceRule, "field" | "pattern" | "tag" | "cf_key"> & {
    eol_fail_on?: string
    coverage_fail_on?: string
    fail_on_unknown?: boolean
    check_type: string
    check_type_display?: string
    scope?: ComplianceExpr | null
    condition?: ComplianceExpr | null
    refs?: Record<string, ComplianceRef>
  }
): string {
  const check = checkSummary(r)
  return r.scope ? `${exprSummary(r.scope, r.refs)} · ${check}` : check
}

function checkSummary(r: Parameters<typeof ruleSummary>[0]): string {
  switch (r.check_type) {
    case "expression":
      return `must: ${exprSummary(r.condition, r.refs)}`
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
