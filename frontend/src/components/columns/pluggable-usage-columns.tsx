import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { AccessoryUsageRow } from "@/lib/api"
import { Badge } from "@/components/ui/badge"

/**
 * A pluggable's Usage tab (docs/dcim/pluggables.md → Usage): each port
 * that shows the part, and each spare record that names it.
 */
export const USAGE_SOURCE_LABEL: Record<AccessoryUsageRow["source"], string> = {
  set: "Set by hand",
  part: "Part number",
  fallback: "Fallback",
}

const dashCell = <span className="text-muted-foreground">-</span>

export function buildPluggableUsageColumns(): ColumnDef<
  AccessoryUsageRow,
  unknown
>[] {
  return [
    {
      id: "device",
      header: "Device",
      accessorFn: (r) => r.device?.name ?? "",
      cell: ({ row }) => {
        const d = row.original.device
        return d ? (
          <Link
            to="/devices/$id"
            params={{ id: d.id }}
            className="link font-medium"
          >
            {d.name}
          </Link>
        ) : (
          dashCell
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Device",
          get: (r: AccessoryUsageRow) => r.device?.id ?? null,
          formatValue: (_v, s) => ({ label: s.device?.name ?? "" }),
        },
      },
    },
    {
      id: "port",
      header: "Port",
      accessorFn: (r) => r.port?.name ?? "",
      cell: ({ row }) => {
        const p = row.original.port
        if (!p) return <span className="text-muted-foreground">Spare</span>
        return p.kind === "interface" ? (
          <Link
            to="/interfaces/$id"
            params={{ id: p.id }}
            className="link font-mono text-xs"
          >
            {p.name}
          </Link>
        ) : (
          <span className="font-mono text-xs">{p.name}</span>
        )
      },
    },
    {
      id: "site",
      header: "Site",
      accessorFn: (r) => r.site?.name ?? "",
      cell: ({ row }) => {
        const s = row.original.site
        return s ? (
          <Link to="/sites/$id" params={{ id: s.id }} className="link text-xs">
            {s.name}
          </Link>
        ) : (
          dashCell
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Site",
          get: (r: AccessoryUsageRow) => r.site?.id ?? null,
          formatValue: (_v, s) => ({ label: s.site?.name ?? "" }),
        },
      },
    },
    {
      id: "serial",
      header: "Serial",
      accessorFn: (r) => r.item?.serial_number ?? "",
      cell: ({ getValue }) =>
        getValue<string>() ? (
          <span className="font-mono text-xs">{getValue<string>()}</span>
        ) : (
          dashCell
        ),
    },
    {
      id: "part_id",
      header: "Part ID",
      accessorFn: (r) => r.item?.part_id ?? "",
      cell: ({ getValue }) =>
        getValue<string>() ? (
          <span className="font-mono text-xs">{getValue<string>()}</span>
        ) : (
          dashCell
        ),
    },
    {
      id: "standard",
      header: "Standard",
      accessorFn: (r) => r.item?.standard ?? "",
      cell: ({ getValue }) =>
        getValue<string>() ? (
          <span className="text-xs">{getValue<string>()}</span>
        ) : (
          dashCell
        ),
    },
    {
      id: "source",
      header: "Source",
      accessorFn: (r) => USAGE_SOURCE_LABEL[r.source],
      cell: ({ getValue }) => (
        <Badge variant="secondary">{getValue<string>()}</Badge>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Source",
          get: (r: AccessoryUsageRow) => r.source,
          formatValue: (v) => ({
            label:
              (USAGE_SOURCE_LABEL as Record<string, string | undefined>)[v] ??
              v,
          }),
        },
      },
    },
    {
      id: "cabled",
      header: "Cabled",
      accessorFn: (r) => (r.cabled ? "Yes" : "No"),
      cell: ({ row }) =>
        row.original.cabled ? (
          <span className="text-xs">
            Yes
            {row.original.cable_type && (
              <span className="ml-1.5 font-mono text-muted-foreground">
                {row.original.cable_type}
              </span>
            )}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No</span>
        ),
    },
  ]
}
