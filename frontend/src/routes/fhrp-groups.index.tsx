import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type FHRPGroup, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { FhrpGroupDeleteDialog } from "@/components/fhrp-group-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/fhrp-groups/")({
  component: FhrpGroupsPage,
})

function FhrpGroupsPage() {
  const [q, setQ] = useState("")
  const [protoFilter, setProtoFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<FHRPGroup | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("fhrpgroup", "add")
  const canEdit = canDo("fhrpgroup", "change")
  const canDelete = canDo("fhrpgroup", "delete")

  const query = useQuery({
    queryKey: ["fhrp-groups", q],
    queryFn: () =>
      api<Paginated<FHRPGroup>>(
        `/api/fhrp-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((g) => {
      if (protoFilter.size > 0 && !protoFilter.has(g.protocol)) return false
      if (tagFilter.size > 0 && !g.tags.some((t) => tagFilter.has(t.slug)))
        return false
      return true
    })
  }, [allRows, protoFilter, tagFilter])

  const facets = useMemo(() => {
    const proto: Record<string, { label: string; count: number }> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    for (const g of allRows) {
      if (!proto[g.protocol])
        proto[g.protocol] = { label: g.protocol_display, count: 0 }
      proto[g.protocol].count++
      for (const t of g.tags) {
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
      proto: Object.entries(proto)
        .sort(([, a], [, b]) => b.count - a.count)
        .map<FacetOption>(([value, v]) => ({
          value,
          label: v.label,
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

  const handleDelete = useCallback((g: FHRPGroup) => setDeleting(g), [])
  const columns = useMemo<ColumnDef<FHRPGroup>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Protocol"
        options={facets.proto}
        selected={protoFilter}
        onToggle={(v) => toggleInSet(protoFilter, v, setProtoFilter)}
      />
      <FacetGroup
        label="Tags"
        options={facets.tags}
        selected={tagFilter}
        onToggle={(v) => toggleInSet(tagFilter, v, setTagFilter)}
      />
    </FilterRail>
  )

  return (
    <ListPageShell
      title="FHRP groups"
      count={query.data ? rows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, group ID…",
      }}
      actions={
        <>
          <TableActions ioType="fhrpgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/fhrp-groups/new">Add FHRP group</Link>
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
        tableId="fhrp-groups"
      />
      <FhrpGroupDeleteDialog
        group={deleting}
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
  onDelete: (g: FHRPGroup) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<FHRPGroup>[] {
  return [
    selectionColumn<FHRPGroup>(),
    ...(humanIds ? [numidColumn<FHRPGroup>({ get: (r) => r.numid })] : []),
    {
      id: "group",
      accessorKey: "group_id",
      header: ({ column }) => <SortHeader column={column} label="Group" />,
      cell: ({ row }) => (
        <Link
          to="/fhrp-groups/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.protocol_display}{" "}
          <span className="font-mono">{row.original.group_id}</span>
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) =>
        row.original.name ? (
          <span className="text-xs">{row.original.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "virtual_ip",
      header: "Virtual IP",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.virtual_ip ? (
          <span className="font-mono text-xs">
            {row.original.virtual_ip.ip_address}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "auth",
      header: "Auth",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.auth_type ? (
          <span className="text-xs">{row.original.auth_type_display}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "members",
      accessorKey: "assignment_count",
      header: ({ column }) => <SortHeader column={column} label="Members" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.assignment_count}</span>
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
    tagsColumn<FHRPGroup>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<FHRPGroup>({
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
          editTo={canEdit ? "/fhrp-groups/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
