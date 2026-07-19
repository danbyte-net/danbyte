import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowLeftRight, Search } from "lucide-react"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Cable, Paginated } from "@/lib/api"
import { fiberColor } from "@/lib/fiber"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { Input } from "@/components/ui/input"
import { DataTable, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { termSummary } from "./cables.index"

export const Route = createFileRoute("/fiber-cables")({
  component: FiberCablesPage,
})

// Strand-count buckets for the filter rail.
function countBucket(n: number | null): string {
  if (!n) return "__none__"
  if (n <= 2) return "2"
  if (n <= 12) return "12"
  if (n <= 24) return "24"
  if (n <= 48) return "48"
  if (n <= 96) return "96"
  return "144+"
}

function labelledCount(c: Cable): number {
  return Object.values(c.strands).filter((s) => s.label || s.status).length
}

function FiberCablesPage() {
  const [q, setQ] = useState("")
  const { humanIds } = useMe()

  const query = useQuery({
    queryKey: ["fiber-cables", q],
    queryFn: () =>
      api<Paginated<Cable>>(
        `/api/cables/?${new URLSearchParams({ fiber: "1", search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo<ColumnDef<Cable>[]>(
    () => buildColumns(humanIds),
    [humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1">
        {rail}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            <h1 className="text-base font-semibold">Fibre cables</h1>
            {query.data && (
              <Badge variant="secondary">{filteredRows.length}</Badge>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Filter by device, port…"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="h-8 w-72 pl-8 text-xs"
                />
              </div>
            </div>
          </header>
          <div className="flex-1 overflow-auto p-4 lg:p-6">
            {query.isLoading && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {query.isError && <QueryError error={query.error} />}
            {query.data && filteredRows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No fibre cables. A cable becomes fibre when its type is a
                single-mode (smf*) or multimode (mmf*) medium.
              </p>
            )}
            {query.data && filteredRows.length > 0 && (
              <DataTable
                data={filteredRows}
                columns={columns}
                flexColumn="a"
                tableId="fiber-cables"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** A compact colour strip previewing the first few strands. */
function StrandPreview({ cable }: { cable: Cable }) {
  const n = cable.fiber_count ?? 0
  if (!n) return <span className="text-muted-foreground">—</span>
  const shown = Math.min(n, 8)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex">
        {Array.from({ length: shown }, (_, i) => (
          <span
            key={i}
            className="h-3 w-1.5 first:rounded-l-sm last:rounded-r-sm"
            style={{ backgroundColor: fiberColor(i + 1).hex }}
          />
        ))}
      </span>
      <span className="num text-xs tabular-nums">{n}</span>
    </span>
  )
}

function buildColumns(humanIds: boolean): ColumnDef<Cable>[] {
  return [
    selectionColumn<Cable>(),
    ...(humanIds ? [numidColumn<Cable>({ get: (r) => r.numid })] : []),
    {
      id: "label",
      accessorKey: "label",
      header: "Label",
      cell: ({ row }) => (
        <Link
          to="/cables/$id"
          params={{ id: row.original.id }}
          className="text-xs hover:underline"
        >
          {row.original.label || (
            <span className="text-muted-foreground">
              Cable #{row.original.numid}
            </span>
          )}
        </Link>
      ),
    },
    {
      id: "a",
      header: "A side",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {termSummary(row.original.a_terminations)}
        </span>
      ),
    },
    {
      id: "link",
      header: "",
      enableSorting: false,
      cell: () => (
        <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
      ),
    },
    {
      id: "b",
      header: "B side",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="font-mono text-xs">
          {termSummary(row.original.b_terminations)}
        </span>
      ),
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) => (
        <span className="text-xs">{row.original.type_display}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: Cable) => r.type || "__none__",
          formatValue: (v, sample) => ({
            label: v === "__none__" ? "—" : sample.type_display || v,
          }),
        },
      },
    },
    {
      id: "strands",
      accessorFn: (r) => r.fiber_count ?? 0,
      header: "Strands",
      cell: ({ row }) => <StrandPreview cable={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Strand count",
          get: (r: Cable) => countBucket(r.fiber_count),
          formatValue: (v) => ({
            label: v === "__none__" ? "Not set" : v,
          }),
        },
      },
    },
    {
      id: "labelled",
      accessorFn: (r) => labelledCount(r),
      header: "Labelled",
      cell: ({ row }) => {
        const l = labelledCount(row.original)
        return l ? (
          <span className="num text-xs tabular-nums">{l}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Cable) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    tagsColumn<Cable>({ getTags: (r) => r.tags }),
    timeAgoColumn<Cable>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
  ]
}
