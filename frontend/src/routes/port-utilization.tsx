import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { siteColumn } from "@/components/cells/site-cell"
import { useTableFilters } from "@/components/table-filters"

// The capacity roll-up half of issue #64: every device with ports, fullest
// first, so the patch panel about to run out is the first row you see.
// Site / role / type facets narrow it; the per-device card on the device
// page shows the same numbers up close.

export const Route = createFileRoute("/port-utilization")({
  component: PortUtilizationPage,
})

interface RollupRow {
  id: string
  name: string
  site: { id: string; name: string } | null
  role: { name: string; color: string } | null
  device_type: string | null
  total: number
  connected: number
  reserved: number
  free: number
  pct: number
}

function PortUtilizationPage() {
  const [search, setSearch] = useState("")
  const q = useQuery({
    queryKey: ["port-utilization-rollup"],
    queryFn: () =>
      api<{ results: RollupRow[] }>("/api/devices/port-utilization/"),
    staleTime: 60_000,
  })
  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const searched = useMemo(() => {
    const s = search.trim().toLowerCase()
    return s ? all.filter((r) => r.name.toLowerCase().includes(s)) : all
  }, [all, search])

  const columns = useMemo<ColumnDef<RollupRow>[]>(
    () => [
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
            {row.original.connected + row.original.reserved}/
            {row.original.total}
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
    ],
    []
  )

  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, searched)

  return (
    <ListPageShell
      title="Port utilization"
      count={q.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "device",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter devices…",
      }}
      query={q}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="name"
        tableId="port-utilization"
        exportName="port-utilization"
        exportTitle="Port utilization"
      />
    </ListPageShell>
  )
}
