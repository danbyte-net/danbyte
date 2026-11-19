import { useMemo } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import { useServerList } from "@/lib/server-list"
import { Badge } from "@/components/ui/badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { rackColumn } from "@/components/cells/rack-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { wireFacetColumns } from "@/components/table-filters"
import { useUrlSearch } from "@/lib/url-filters"

// The capacity roll-up half of issue #64: every device with counted ports,
// fullest first, so the patch panel about to run out is the first row you
// see. Site / rack / role / type facets narrow it; the per-device card on the
// device page shows the same numbers up close. Paged, sorted and counted on
// the server from the stored port counts (#535).

/** The rail's facets, counted by the server (`/api/port-utilization/facets/`). */
const FACETS = ["site", "rack", "role", "type"]

export const Route = createFileRoute("/port-utilization")({
  component: PortUtilizationPage,
  // Deep links from a site or rack land on the pre-filtered table, e.g.
  // /port-utilization?rack=<id>. Both keys optional.
  validateSearch: (
    s: Record<string, unknown>
  ): { site?: string; rack?: string } => {
    const out: { site?: string; rack?: string } = {}
    if (typeof s.site === "string") out.site = s.site
    if (typeof s.rack === "string") out.rack = s.rack
    return out
  },
})

interface RollupRow {
  id: string
  name: string
  site: { id: string; name: string } | null
  rack: { id: string; name: string } | null
  role: { name: string; color: string } | null
  device_type: string | null
  total: number
  connected: number
  reserved: number
  free: number
  pct: number
}

function PortUtilizationPage() {
  const [search, setSearch] = useUrlSearch()
  const facetColumns = useMemo(() => rollupColumns(), [])
  // The query key is the port counts' (lib/port-utilization.ts): a write
  // that moves a port count refreshes the page.
  const list = useServerList<RollupRow>({
    endpoint: "/api/port-utilization/",
    queryKey: "port-utilization-rollup",
    columns: facetColumns,
    facets: FACETS,
    savedViews: "port-utilization",
  })
  const { selectedValues, toggleValue } = list
  const columns = useMemo(
    () => wireFacetColumns(facetColumns, selectedValues, toggleValue),
    [facetColumns, selectedValues, toggleValue]
  )

  return (
    <ListPageShell
      title="Port utilization"
      count={list.query.data ? list.total : undefined}
      rail={list.rail}
      savedViews={list.savedViews}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter devices…",
      }}
      summary={
        (list.query.data as { summary?: { building?: boolean } } | undefined)
          ?.summary?.building && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="warning">Building</Badge>
            The counts are still being built - some devices are not listed yet.
          </p>
        )
      }
      query={list.query}
    >
      <DataTable
        data={list.rows}
        columns={columns}
        {...list.tableProps}
        flexColumn="name"
        tableId="port-utilization"
        exportName="port-utilization"
        exportTitle="Port utilization"
      />
    </ListPageShell>
  )
}

function rollupColumns(): ColumnDef<RollupRow, unknown>[] {
  return [
    // Tick rows to export just those - the Download menu exports the
    // selection when one exists.
    selectionColumn<RollupRow>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => (
        <Link
          to="/devices/$id"
          params={{ id: row.original.id }}
          className="link font-mono font-medium"
        >
          {row.original.name}
        </Link>
      ),
    },
    siteColumn<RollupRow>({ get: (r) => r.site }),
    rackColumn<RollupRow>({ get: (r) => r.rack }),
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: RollupRow) => r.role?.name ?? "__none__",
          formatValue: (_v: string, sample: RollupRow) => ({
            label: sample.role?.name ?? "No role",
          }),
        },
      },
    },
    {
      id: "type",
      accessorFn: (r) => r.device_type ?? "",
      header: ({ column }) => <SortHeader column={column} label="Type" />,
      cell: ({ row }) =>
        row.original.device_type ? (
          <Badge variant="outline">{row.original.device_type}</Badge>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Device type",
          get: (r: RollupRow) => r.device_type ?? "__none__",
          formatValue: (_v: string, sample: RollupRow) => ({
            label: sample.device_type ?? "No type",
          }),
        },
      },
    },
    {
      id: "utilization",
      accessorFn: (r) => r.pct,
      header: ({ column }) => (
        <SortHeader column={column} label="Utilization" />
      ),
      cell: ({ row }) => {
        const r = row.original
        return (
          <span className="flex items-center gap-2">
            <span className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
              <span
                className="bg-emerald-500"
                style={{ width: `${(r.connected / r.total) * 100}%` }}
              />
              <span
                className="bg-amber-500"
                style={{ width: `${(r.reserved / r.total) * 100}%` }}
              />
            </span>
            <span className="num text-xs">{r.pct}%</span>
          </span>
        )
      },
    },
    {
      id: "used",
      accessorFn: (r) => r.connected + r.reserved,
      header: ({ column }) => <SortHeader column={column} label="Used" />,
      cell: ({ row }) => (
        <span className="num">
          {row.original.connected + row.original.reserved}/{row.original.total}
        </span>
      ),
    },
    {
      id: "reserved",
      accessorFn: (r) => r.reserved,
      header: ({ column }) => <SortHeader column={column} label="Reserved" />,
      cell: ({ row }) =>
        row.original.reserved > 0 ? (
          <span className="num text-amber-600 dark:text-amber-400">
            {row.original.reserved}
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "free",
      accessorFn: (r) => r.free,
      header: ({ column }) => <SortHeader column={column} label="Free" />,
      cell: ({ row }) => <span className="num">{row.original.free}</span>,
    },
  ]
}
