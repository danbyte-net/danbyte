import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import type {
  ComplianceOffender,
  ComplianceRule,
  ComplianceRuleResult,
  ComplianceSeverity,
  ComplianceViolation,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import {
  CONFIG_DRIFT_RULE_ID,
  OBJ_ROUTE,
  SEV_VARIANT,
  SEVERITY_RANK,
  SeverityBadge,
  TriageBadge,
  countOf,
  ruleSummary,
} from "@/components/compliance/compliance-shared"

const sevSort = (s: ComplianceSeverity) => SEVERITY_RANK[s]

/** The object's name, linked to its page. */
export function ObjectLink({
  objectType,
  id,
  label,
}: {
  objectType: string
  id: string
  label: string
}) {
  const route = OBJ_ROUTE[objectType]
  return route ? (
    <Link to={route} params={{ id }} className="link font-mono font-medium">
      {label}
    </Link>
  ) : (
    <span className="font-mono font-medium">{label}</span>
  )
}

/** A rule's name, linked to its page - config drift to the drift page. */
export function RuleLink({
  id,
  name,
  muted,
}: {
  id: string
  name: string
  muted?: boolean
}) {
  const cls = muted
    ? "link text-muted-foreground hover:text-foreground"
    : "link font-medium"
  return id === CONFIG_DRIFT_RULE_ID ? (
    <Link to="/config-drift" className={cls}>
      {name}
    </Link>
  ) : (
    <Link to="/compliance-rules/$id" params={{ id }} className={cls}>
      {name}
    </Link>
  )
}

/** The rule's current result: an OK badge, or its open failures counted in
 * its object type and tinted by its severity, linked to the Violations tab
 * filtered to it. Triaged failures follow, muted. */
export function RuleResult({
  rule,
  enabled = true,
}: {
  rule?: Pick<
    ComplianceRuleResult,
    | "id"
    | "severity"
    | "object_type"
    | "violations"
    | "open"
    | "acknowledged"
    | "snoozed"
  >
  enabled?: boolean
}) {
  if (!enabled) return <Badge variant="outline">Disabled</Badge>
  if (!rule) return <span className="text-muted-foreground">-</span>
  if (rule.violations === 0) return <Badge variant="success">OK</Badge>
  const open = rule.open ?? rule.violations
  const triaged = rule.violations - open
  return (
    <span className="inline-flex items-center gap-2">
      {open > 0 ? (
        <Link
          to="/compliance"
          search={{ tab: "violations", rule: rule.id, state: "open" }}
          className="rounded-[5px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <Badge variant={SEV_VARIANT[rule.severity]}>
            {countOf(rule.object_type, open)}
          </Badge>
        </Link>
      ) : (
        <Badge variant="secondary">All triaged</Badge>
      )}
      {triaged > 0 && (
        <Link
          to="/compliance"
          search={{
            tab: "violations",
            rule: rule.id,
            state: "acknowledged,snoozed",
          }}
          className="link text-xs text-muted-foreground"
        >
          {triaged.toLocaleString()} triaged
        </Link>
      )}
    </span>
  )
}

// ─── Violations ──────────────────────────────────────────────────────────────

/** One violation: a rule failing an object. `select` adds the checkbox
 * column the triage bar works from. */
export function violationColumns<
  T extends ComplianceViolation = ComplianceViolation,
>({
  select,
}: {
  select?: boolean
} = {}): ColumnDef<T>[] {
  const cols: ColumnDef<T>[] = [
    {
      id: "severity",
      accessorFn: (v) => sevSort(v.severity),
      header: ({ column }) => <SortHeader column={column} label="Severity" />,
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      id: "object",
      accessorKey: "object_repr",
      header: ({ column }) => <SortHeader column={column} label="Object" />,
      cell: ({ row }) => {
        const v = row.original
        const name = (
          <ObjectLink
            objectType={v.object_type}
            id={v.object_id}
            label={v.object_repr}
          />
        )
        return v.detail ? (
          <span className="whitespace-nowrap">
            {name}
            <span className="ml-2 text-xs text-muted-foreground">
              {v.detail}
            </span>
          </span>
        ) : (
          name
        )
      },
    },
    {
      id: "type",
      accessorKey: "object_type_label",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.object_type_label}
        </span>
      ),
    },
    {
      id: "rule",
      accessorKey: "rule_name",
      header: ({ column }) => <SortHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <RuleLink
          id={row.original.rule_id}
          name={row.original.rule_name}
          muted
        />
      ),
    },
    {
      id: "site",
      accessorFn: (v) => v.site_name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) =>
        row.original.site_id ? (
          <Link
            to="/sites/$id"
            params={{ id: row.original.site_id }}
            className="link text-muted-foreground hover:text-foreground"
          >
            {row.original.site_name}
          </Link>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "state",
      accessorFn: (v) => v.state ?? "open",
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => {
        const v = row.original
        return (
          <span className="inline-flex items-center gap-2">
            <TriageBadge state={v.state} showOpen />
            {v.state === "snoozed" && v.snoozed_until ? (
              <span className="text-xs text-muted-foreground">
                until <TimeCell iso={v.snoozed_until} />
              </span>
            ) : v.state === "acknowledged" && v.acknowledged_at ? (
              <span className="text-xs text-muted-foreground">
                {v.acknowledged_by} · <TimeCell iso={v.acknowledged_at} />
              </span>
            ) : null}
          </span>
        )
      },
    },
    {
      id: "note",
      accessorFn: (v) => v.note ?? "",
      header: "Note",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.note || ""}
        </span>
      ),
    },
  ]
  return select ? [selectionColumn<T>(), ...cols] : cols
}

// ─── Top offenders ───────────────────────────────────────────────────────────

export function offenderColumns(): ColumnDef<ComplianceOffender>[] {
  return [
    {
      id: "object",
      accessorKey: "object_repr",
      header: ({ column }) => <SortHeader column={column} label="Object" />,
      cell: ({ row }) => (
        <ObjectLink
          objectType={row.original.object_type}
          id={row.original.object_id}
          label={row.original.object_repr}
        />
      ),
    },
    {
      id: "type",
      accessorKey: "object_type_label",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.object_type_label}
        </span>
      ),
    },
    {
      id: "site",
      accessorKey: "site_name",
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.site_name || "-"}
        </span>
      ),
    },
    {
      id: "worst",
      accessorFn: (o) => sevSort(o.worst_severity),
      header: ({ column }) => <SortHeader column={column} label="Worst" />,
      cell: ({ row }) => (
        <SeverityBadge severity={row.original.worst_severity} />
      ),
    },
    {
      id: "rules",
      accessorFn: (o) => o.rules.join(", "),
      header: "Rules",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {row.original.rules.join(", ")}
        </span>
      ),
    },
    {
      id: "violations",
      accessorKey: "violations",
      header: ({ column }) => <SortHeader column={column} label="Violations" />,
      cell: ({ row }) => (
        <Link
          to="/compliance"
          search={{ tab: "violations", device: row.original.object_id }}
          className="num link font-medium"
        >
          {row.original.violations}
        </Link>
      ),
    },
  ]
}

// ─── Rules ───────────────────────────────────────────────────────────────────

/** The Rules tab: each rule with its condition, severity and live result. */
export function ruleColumns({
  results,
}: {
  results: Map<string, ComplianceRuleResult>
}): ColumnDef<ComplianceRule>[] {
  return [
    {
      id: "rule",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Rule" />,
      cell: ({ row }) => (
        <RuleLink id={row.original.id} name={row.original.name} />
      ),
    },
    {
      id: "severity",
      accessorFn: (r) => sevSort(r.severity),
      header: ({ column }) => <SortHeader column={column} label="Severity" />,
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      id: "result",
      accessorFn: (r) => {
        const res = results.get(r.id)
        if (!r.enabled || !res) return -1
        return (
          (res.open ?? res.violations) * 10 +
          (res.violations > 0 ? sevSort(r.severity) : 0)
        )
      },
      header: ({ column }) => <SortHeader column={column} label="Result" />,
      cell: ({ row }) => (
        <RuleResult
          rule={results.get(row.original.id)}
          enabled={row.original.enabled}
        />
      ),
    },
    {
      id: "applies",
      accessorKey: "object_type_label",
      header: ({ column }) => <SortHeader column={column} label="Applies to" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.object_type_label}
        </span>
      ),
    },
    {
      id: "check",
      accessorFn: (r) => ruleSummary(r),
      header: "Check",
      cell: ({ row }) => (
        <span className="text-[12px] text-muted-foreground">
          {ruleSummary(row.original)}
        </span>
      ),
    },
  ]
}
