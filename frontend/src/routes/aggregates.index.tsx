import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Aggregate, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { AggregateDeleteDialog } from "@/components/aggregate-delete-dialog"
import { UtilCell } from "@/components/cells/util-cell"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/aggregates/")({
  component: AggregatesPage,
})

function AggregatesPage() {
  const [q, setQ] = useState("")
  const [rirFilter, setRirFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<Aggregate | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("aggregate", "add")
  const canEdit = canDo("aggregate", "change")
  const canDelete = canDo("aggregate", "delete")

  const query = useQuery({
    queryKey: ["aggregates", q],
    queryFn: () =>
      api<Paginated<Aggregate>>(
        `/api/aggregates/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((a) => {
      if (rirFilter.size > 0) {
        const key = a.rir?.id ?? "__none__"
        if (!rirFilter.has(key)) return false
      }
      if (tagFilter.size > 0 && !a.tags.some((t) => tagFilter.has(t.slug)))
        return false
      return true
    })
  }, [allRows, rirFilter, tagFilter])

  const facets = useMemo(() => {
    const rirs: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    for (const a of allRows) {
      const rk = a.rir?.id ?? "__none__"
      if (!rirs[rk]) rirs[rk] = { name: a.rir?.name ?? "—", count: 0 }
      rirs[rk].count++
      for (const t of a.tags) {
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
      rirs: Object.entries(rirs)
        .sort(([, a], [, b]) => b.count - a.count)
        .map<FacetOption>(([id, v]) => ({
          value: id,
          label: v.name,
          count: v.count,
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

  const handleDelete = useCallback((a: Aggregate) => setDeleting(a), [])
  const columns = useMemo<ColumnDef<Aggregate>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Aggregates"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="RIR"
            options={facets.rirs}
            selected={rirFilter}
            onToggle={(v) => toggleInSet(rirFilter, v, setRirFilter)}
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
        placeholder: "Filter by prefix, description…",
      }}
      actions={
        <>
          <TableActions ioType="aggregate" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/aggregates/new">Add aggregate</Link>
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
        tableId="aggregates"
      />
      <AggregateDeleteDialog
        aggregate={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (a: Aggregate) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Aggregate>[] {
  return [
    selectionColumn<Aggregate>(),
    ...(humanIds ? [numidColumn<Aggregate>({ get: (r) => r.numid })] : []),
    {
      id: "prefix",
      accessorKey: "prefix",
      header: ({ column }) => <SortHeader column={column} label="Prefix" />,
      cell: ({ row }) => (
        <Link
          to="/aggregates/$id"
          params={{ id: row.original.id }}
          className="font-mono text-[13px] font-medium hover:underline"
        >
          {row.original.prefix}
        </Link>
      ),
    },
    {
      id: "rir",
      accessorFn: (a) => a.rir?.name ?? "",
      header: "RIR",
      cell: ({ row }) =>
        row.original.rir ? (
          <span className="text-xs">{row.original.rir.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "utilisation",
      accessorKey: "utilisation_pct",
      header: ({ column }) => (
        <SortHeader column={column} label="Utilisation" />
      ),
      cell: ({ row }) => <UtilCell pct={row.original.utilisation_pct} />,
    },
    {
      id: "date_added",
      accessorKey: "date_added",
      header: "Added",
      cell: ({ row }) =>
        row.original.date_added ? (
          <span className="num text-xs">{row.original.date_added}</span>
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
    tagsColumn<Aggregate>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<Aggregate>({
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
          editTo={canEdit ? "/aggregates/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
