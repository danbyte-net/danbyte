import type { ColumnDef } from "@tanstack/react-table"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { EolInfo, EolSettings, EolStatus } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader } from "@/components/data-table"
import { dash } from "@/components/cells/dash"

// End-of-life data from endoflife.date (#8) - a platform's mapped cycle,
// rendered the same way on the platform page and the device / VM lists:
//
//   <EolBadge info={platform.eol} />
//   eolColumn<MyRow>({ get: (r) => r.platform?.eol })   - column + facet
//   useEolSettings().enabled                             - show it at all

export const EOL_LABELS: Record<EolStatus, string> = {
  supported: "Supported",
  ending: "Support ending",
  eol: "End of life",
  unknown: "Unknown",
}

const VARIANT: Record<
  EolStatus,
  "success" | "warning" | "destructive" | "secondary"
> = {
  supported: "success",
  ending: "warning",
  eol: "destructive",
  unknown: "secondary",
}

const RANK: Record<EolStatus, number> = {
  eol: 0,
  ending: 1,
  supported: 2,
  unknown: 3,
}

export function EolBadge({ info }: { info: EolInfo | null | undefined }) {
  if (!info) return dash
  return <Badge variant={VARIANT[info.status]}>{EOL_LABELS[info.status]}</Badge>
}

/** The deployment's end-of-life switch. Everyone signed in may read it. */
export function useEolSettings() {
  const q = useQuery({
    queryKey: ["eol-settings"],
    queryFn: () => api<EolSettings>("/api/eol/settings/"),
    staleTime: 5 * 60_000,
  })
  return { ...q, enabled: !!q.data?.enabled }
}

export function eolColumn<T>(opts: {
  get: (row: T) => EolInfo | null | undefined
  id?: string
}): ColumnDef<T, unknown> {
  return {
    id: opts.id ?? "eol",
    accessorFn: (r) => RANK[opts.get(r)?.status ?? "unknown"],
    header: ({ column }) => <SortHeader column={column} label="End of life" />,
    cell: ({ row }) => <EolBadge info={opts.get(row.original)} />,
    meta: {
      label: "End of life",
      facet: {
        kind: "enum",
        label: "End of life",
        get: (r: T) => opts.get(r)?.status ?? "unknown",
        formatValue: (v) => ({
          label: (EOL_LABELS as Record<string, string | undefined>)[v] ?? v,
        }),
      },
      export: {
        value: (r: T) => EOL_LABELS[opts.get(r)?.status ?? "unknown"],
      },
    },
  }
}
