import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { SlaAgreement, SlaIncident, SlaMemberFigure } from "@/lib/api"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { SortHeader } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import {
  PERIOD_LABEL,
  SlaFigureBadge,
  SlaStateBadge,
  fmtBudget,
  fmtSla,
} from "@/components/monitoring/sla-figure"
import { fmtSpan } from "@/components/monitoring/status-strip"

/** An agreement, as a row of the SLAs list. */
export function slaAgreementColumns(): ColumnDef<SlaAgreement>[] {
  return [
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: ({ column }) => <SortHeader column={column} label="Agreement" />,
      cell: ({ row }) => (
        <Link
          to="/monitoring/sla/$id"
          params={{ id: row.original.id }}
          className="link font-medium"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "for",
      accessorFn: (r) => r.for_label,
      header: ({ column }) => <SortHeader column={column} label="For" />,
      cell: ({ row }) => row.original.for_label || dash,
    },
    {
      id: "target",
      accessorFn: (r) => Number(r.target_pct),
      header: ({ column }) => <SortHeader column={column} label="Target" />,
      cell: ({ row }) => (
        <span className="num">{fmtSla(Number(row.original.target_pct))}</span>
      ),
    },
    {
      id: "period",
      accessorFn: (r) => r.period,
      header: "Period",
      cell: ({ row }) => PERIOD_LABEL[row.original.period],
    },
    {
      id: "figure",
      accessorFn: (r) => r.current?.figures.availability ?? -1,
      header: ({ column }) => (
        <SortHeader column={column} label="This period" />
      ),
      cell: ({ row }) => (
        <SlaFigureBadge figures={row.original.current?.figures} />
      ),
    },
    {
      id: "state",
      accessorFn: (r) => r.current?.figures.state ?? "",
      header: "State",
      cell: ({ row }) =>
        row.original.status !== "active" ? (
          <Badge variant="secondary">
            {row.original.status === "draft" ? "Draft" : "Archived"}
          </Badge>
        ) : row.original.current ? (
          <SlaStateBadge state={row.original.current.figures.state} />
        ) : (
          dash
        ),
    },
    {
      id: "budget",
      accessorFn: (r) => r.current?.figures.budget_left_s ?? 0,
      header: ({ column }) => (
        <SortHeader column={column} label="Budget left" />
      ),
      cell: ({ row }) => {
        const f = row.original.current?.figures
        if (!f) return dash
        return (
          <span
            className={`num ${f.budget_left_s < 0 ? "text-destructive" : ""}`}
          >
            {fmtBudget(f.budget_left_s)}
          </span>
        )
      },
    },
    {
      id: "coverage",
      accessorFn: (r) => r.current?.figures.coverage ?? -1,
      header: "Coverage",
      cell: ({ row }) => {
        const c = row.original.current?.figures.coverage
        return c == null ? dash : <span className="num">{Math.round(c)}%</span>
      },
    },
    {
      id: "members",
      accessorFn: (r) => r.member_count,
      header: ({ column }) => <SortHeader column={column} label="Members" />,
      cell: ({ row }) => (
        <span className="num">{row.original.member_count}</span>
      ),
    },
  ]
}

const MEMBER_ROUTE = {
  "api.device": "/devices/$id",
  "api.virtualmachine": "/virtual-machines/$id",
  "api.ipaddress": "/ips/$id",
} as const

/** A member's figure inside one period of an agreement. */
export function slaMemberColumns(): ColumnDef<SlaMemberFigure>[] {
  return [
    {
      id: "name",
      accessorFn: (r) => r.name,
      header: "Member",
      cell: ({ row }) => {
        const m = row.original
        return (
          <span className="inline-flex items-center gap-1.5">
            <Link
              to={MEMBER_ROUTE[m.object_type]}
              params={{ id: m.object_id }}
              className={`link ${m.object_type === "api.ipaddress" ? "font-mono" : ""}`}
            >
              {m.name}
            </Link>
            {m.selected && <Badge variant="outline">By selector</Badge>}
          </span>
        )
      },
    },
    {
      id: "group",
      accessorFn: (r) => r.group,
      header: "Group",
      cell: ({ row }) => row.original.group,
    },
    {
      id: "redundancy",
      accessorFn: (r) => r.redundancy_group,
      header: "Redundancy",
      cell: ({ row }) => row.original.redundancy_group || dash,
    },
    {
      id: "availability",
      accessorFn: (r) => r.availability ?? -1,
      header: "Availability",
      cell: ({ row }) => (
        <span className="num">{fmtSla(row.original.availability)}</span>
      ),
    },
    {
      id: "down",
      accessorFn: (r) => r.down_s,
      header: "Down",
      cell: ({ row }) =>
        row.original.down_s ? (
          <span className="num">{fmtSpan(row.original.down_s * 1000)}</span>
        ) : (
          dash
        ),
    },
    {
      id: "coverage",
      accessorFn: (r) => r.coverage ?? -1,
      header: "Coverage",
      cell: ({ row }) =>
        row.original.coverage == null ? (
          dash
        ) : (
          <span className="num">{Math.round(row.original.coverage)}%</span>
        ),
    },
    {
      id: "worst",
      accessorFn: (r) => r.worst_item ?? "",
      header: "Worst check",
      cell: ({ row }) => row.original.worst_item ?? dash,
    },
  ]
}

/** An outage that spent budget. */
export function slaIncidentColumns(): ColumnDef<SlaIncident>[] {
  return [
    {
      id: "start",
      accessorFn: (r) => r.start,
      header: "Started",
      cell: ({ row }) => <TimeCell iso={row.original.start} />,
    },
    {
      id: "seconds",
      accessorFn: (r) => r.seconds,
      header: "Lasted",
      cell: ({ row }) => (
        <span className="num">{fmtSpan(row.original.seconds * 1000)}</span>
      ),
    },
    {
      id: "label",
      accessorFn: (r) => r.label,
      header: "Unit",
      cell: ({ row }) => row.original.label,
    },
    {
      id: "members",
      accessorFn: (r) => r.members.join(", "),
      header: "Down",
      cell: ({ row }) => row.original.members.join(", ") || dash,
    },
  ]
}
