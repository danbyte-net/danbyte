import type { ColumnDef } from "@tanstack/react-table"

import type {
  ContractState,
  CoverageStatus,
  DeviceCoverageBrief,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"

// Support & warranty coverage (#421) - a device's status derived server-side
// from its contracts and warranty date, and a contract's own state:
//
//   <CoverageBadge status={device.coverage?.status} />
//   <ContractStateBadge state={contract.state} />
//   coverageColumn<MyRow>({ get: (r) => r.coverage })   - column + facet

export const COVERAGE_LABELS: Record<CoverageStatus, string> = {
  covered: "Covered",
  expiring: "Expiring",
  expired: "Expired",
  none: "Not covered",
}

export const CONTRACT_STATE_LABELS: Record<ContractState, string> = {
  active: "Active",
  expiring: "Expiring",
  expired: "Expired",
}

type Variant = "success" | "warning" | "destructive" | "secondary"

const COVERAGE_VARIANT: Record<CoverageStatus, Variant> = {
  covered: "success",
  expiring: "warning",
  expired: "destructive",
  none: "secondary",
}

const STATE_VARIANT: Record<ContractState, Variant> = {
  active: "success",
  expiring: "warning",
  expired: "destructive",
}

/** Worst first, so a sort puts what needs attention on top. */
export const COVERAGE_RANK: Record<CoverageStatus, number> = {
  expired: 0,
  none: 1,
  expiring: 2,
  covered: 3,
}

export function CoverageBadge({
  status,
}: {
  status: CoverageStatus | null | undefined
}) {
  if (!status) return dash
  return (
    <Badge variant={COVERAGE_VARIANT[status]}>{COVERAGE_LABELS[status]}</Badge>
  )
}

export function ContractStateBadge({
  state,
}: {
  state: ContractState | null | undefined
}) {
  if (!state) return dash
  return (
    <Badge variant={STATE_VARIANT[state]}>{CONTRACT_STATE_LABELS[state]}</Badge>
  )
}

export function coverageColumn<T>(opts: {
  get: (row: T) => DeviceCoverageBrief | null | undefined
  id?: string
}): ColumnDef<T, unknown> {
  return {
    id: opts.id ?? "coverage",
    accessorFn: (r) => COVERAGE_RANK[opts.get(r)?.status ?? "none"],
    header: ({ column }) => <SortHeader column={column} label="Coverage" />,
    cell: ({ row }) => (
      <CoverageBadge status={opts.get(row.original)?.status} />
    ),
    meta: {
      label: "Coverage",
      facet: {
        kind: "enum",
        label: "Coverage",
        get: (r: T) => opts.get(r)?.status ?? "none",
        formatValue: (v) => ({
          label:
            (COVERAGE_LABELS as Record<string, string | undefined>)[v] ?? v,
        }),
      },
      export: {
        value: (r: T) => COVERAGE_LABELS[opts.get(r)?.status ?? "none"],
      },
    },
  }
}
