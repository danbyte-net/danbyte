import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ResolvedPathway } from "@/lib/api"
import {
  KIND_LABEL,
  SOURCE_LABEL,
  SUBKIND_LABEL,
  sizeText,
  sourceRank,
  unitsText,
  whereText,
} from "@/lib/rack-pathways"
import { SortHeader } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { dash } from "@/components/cells/dash"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of rack pathways": the rack's
// Pathways tab and the rack type's both build their columns here.

export type RackPathwayColumnId =
  | "name"
  | "source"
  | "kind"
  | "subkind"
  | "where"
  | "units"
  | "size"
  | "fill"
  | "devices"
  | "cables"
  | "model"

const SOURCE_VARIANT = {
  kit: "info",
  default: "secondary",
  type: "secondary",
  manual: "outline",
} as const

export function SourceBadge({ p }: { p: ResolvedPathway }) {
  return (
    <Badge variant={SOURCE_VARIANT[p.source]}>{SOURCE_LABEL[p.source]}</Badge>
  )
}

export function buildRackPathwayColumns(
  opts: {
    include?: RackPathwayColumnId[]
    actions?: ActionsColumnOpts<ResolvedPathway>
  } = {}
): ColumnDef<ResolvedPathway, unknown>[] {
  const all: Record<
    RackPathwayColumnId,
    ColumnDef<ResolvedPathway, unknown>
  > = {
    name: {
      id: "name",
      accessorFn: (p) => p.label,
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => {
        const p = row.original
        return (
          <span className="flex items-center gap-2 whitespace-nowrap">
            <span
              className={p.hidden ? "text-muted-foreground" : "font-medium"}
            >
              {p.label}
            </span>
            {p.hidden && (
              <Badge variant="secondary">{p.addon ? "Add-on" : "Hidden"}</Badge>
            )}
            {p.orphan && <Badge variant="warning">Not in kit</Badge>}
          </span>
        )
      },
    },
    source: {
      id: "source",
      accessorFn: (p) => sourceRank(p.source),
      header: ({ column }) => <SortHeader column={column} label="Source" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-1 whitespace-nowrap">
          <SourceBadge p={row.original} />
          {row.original.overridden.length > 0 && (
            <Badge variant="outline">Changed</Badge>
          )}
        </span>
      ),
    },
    kind: {
      id: "kind",
      accessorFn: (p) => KIND_LABEL[p.kind],
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
    },
    subkind: {
      id: "subkind",
      accessorFn: (p) => (p.subkind ? SUBKIND_LABEL[p.subkind] : ""),
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ getValue }) => (getValue() as string) || dash,
    },
    where: {
      id: "where",
      accessorFn: (p) => whereText(p),
      header: ({ column }) => <SortHeader column={column} label="Where" />,
      cell: ({ getValue }) => (getValue() as string) || dash,
    },
    units: {
      id: "units",
      accessorFn: (p) => p.u_from ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Units" />,
      cell: ({ row }) => (
        <span className="num whitespace-nowrap">
          {unitsText(row.original) || dash}
        </span>
      ),
    },
    size: {
      id: "size",
      accessorFn: (p) => (p.inner_w_mm ?? 0) * (p.inner_d_mm ?? 0),
      header: ({ column }) => <SortHeader column={column} label="Inner size" />,
      cell: ({ row }) => (
        <span className="num whitespace-nowrap">
          {sizeText(row.original) || dash}
        </span>
      ),
    },
    fill: {
      id: "fill",
      accessorFn: (p) => (p.kind === "channel" ? -1 : p.fill_limit_pct),
      header: ({ column }) => <SortHeader column={column} label="Fill limit" />,
      cell: ({ row }) =>
        row.original.kind === "channel" ? (
          dash
        ) : (
          <span className="num">{row.original.fill_limit_pct} %</span>
        ),
    },
    devices: {
      id: "devices",
      accessorFn: (p) => p.devices?.length ?? 0,
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => {
        const p = row.original
        const devs = p.devices ?? (p.device ? [p.device] : [])
        if (devs.length === 0) return dash
        return (
          <span className="flex flex-wrap gap-x-2">
            {devs.map((d) => (
              <Link
                key={d.id}
                to="/devices/$id"
                params={{ id: d.id }}
                className="link"
              >
                {d.name}
              </Link>
            ))}
          </span>
        )
      },
    },
    cables: {
      id: "cables",
      accessorFn: (p) => p.cables ?? 0,
      header: ({ column }) => <SortHeader column={column} label="Cables" />,
      cell: ({ row }) => {
        const p = row.original
        if (!p.cables || !p.id) return dash
        return (
          <Link to="/cables" search={{ pathway: p.id }} className="link num">
            {p.cables}
          </Link>
        )
      },
    },
    model: {
      id: "model",
      accessorFn: (p) => p.accessory_type?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Model" />,
      cell: ({ row }) => {
        const a = row.original.accessory_type
        return a ? (
          <Link to="/pluggables/$id" params={{ id: a.id }} className="link">
            {a.name}
          </Link>
        ) : (
          dash
        )
      },
    },
  }
  const ids = opts.include ?? (Object.keys(all) as RackPathwayColumnId[])
  const cols = ids.map((id) => all[id])
  if (opts.actions) cols.push(actionsColumn(opts.actions))
  return cols
}
