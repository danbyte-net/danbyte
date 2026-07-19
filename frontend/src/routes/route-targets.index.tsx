import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type RouteTarget } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { RtDeleteDialog } from "@/components/rt-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/route-targets/")({ component: RtsPage })

function RtsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("routetarget", "add")
  const canEdit = canDo("routetarget", "change")
  const canDelete = canDo("routetarget", "delete")
  const [q, setQ] = useState("")
  const [usageFilter, setUsageFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<RouteTarget | null>(null)

  const query = useQuery({
    queryKey: ["rts", q],
    queryFn: () =>
      api<Paginated<RouteTarget>>(
        `/api/route-targets/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (usageFilter.size > 0) {
        const used = r.import_vrf_count + r.export_vrf_count > 0
        const onlyImport = r.import_vrf_count > 0 && r.export_vrf_count === 0
        const onlyExport = r.export_vrf_count > 0 && r.import_vrf_count === 0
        const both = r.import_vrf_count > 0 && r.export_vrf_count > 0
        const empty = !used
        const hit =
          (usageFilter.has("both") && both) ||
          (usageFilter.has("import") && onlyImport) ||
          (usageFilter.has("export") && onlyExport) ||
          (usageFilter.has("empty") && empty)
        if (!hit) return false
      }
      if (tagFilter.size > 0 && !r.tags.some((t) => tagFilter.has(t.slug)))
        return false
      return true
    })
  }, [allRows, usageFilter, tagFilter])

  const facets = useMemo(() => {
    const usage: Record<string, number> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    for (const r of allRows) {
      const imp = r.import_vrf_count > 0
      const exp = r.export_vrf_count > 0
      const key =
        imp && exp ? "both" : imp ? "import" : exp ? "export" : "empty"
      usage[key] = (usage[key] ?? 0) + 1
      for (const t of r.tags) {
        if (!tags[t.slug])
          tags[t.slug] = {
            name: t.name,
            color: t.color,
            textColor: t.text_color,
            count: 0,
          }
        tags[t.slug].count++
      }
    }
    return {
      usage: (["both", "import", "export", "empty"] as const)
        .filter((k) => usage[k])
        .map<FacetOption>((k) => ({
          value: k,
          label:
            k === "both"
              ? "Import + Export"
              : k === "import"
                ? "Import only"
                : k === "export"
                  ? "Export only"
                  : "Unused",
          count: usage[k],
        })),
      tags: Object.entries(tags)
        .sort(([, a], [, b]) => b.count - a.count)
        .map<FacetOption>(([slug, v]) => ({
          value: slug,
          label: v.name,
          count: v.count,
          color: v.color,
          textColor: v.textColor,
        })),
    }
  }, [allRows])

  const handleDelete = useCallback((r: RouteTarget) => setDeleting(r), [])

  const columns = useMemo<ColumnDef<RouteTarget>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Route Targets"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Usage"
            options={facets.usage}
            selected={usageFilter}
            onToggle={(v) => toggleInSet(usageFilter, v, setUsageFilter)}
          />
          <FacetGroup
            label="Tags"
            options={facets.tags}
            selected={tagFilter}
            onToggle={(v) => toggleInSet(tagFilter, v, setTagFilter)}
          />
        </FilterRail>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, description…",
      }}
      actions={
        <>
          <TableActions ioType="routetarget" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/route-targets/new">Add RT</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="route-targets"
      />
      <RtDeleteDialog
        rt={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (r: RouteTarget) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<RouteTarget>[] {
  return [
    selectionColumn<RouteTarget>(),
    ...(humanIds ? [numidColumn<RouteTarget>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/route-targets/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "imports",
      accessorKey: "import_vrf_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Imported by" />
      ),
      cell: ({ row }) =>
        row.original.import_vrf_count > 0 ? (
          <span className="num text-xs">
            {row.original.import_vrf_count} VRF
            {row.original.import_vrf_count === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "exports",
      accessorKey: "export_vrf_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Exported by" />
      ),
      cell: ({ row }) =>
        row.original.export_vrf_count > 0 ? (
          <span className="num text-xs">
            {row.original.export_vrf_count} VRF
            {row.original.export_vrf_count === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    tagsColumn<RouteTarget>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<RouteTarget>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/route-targets/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
