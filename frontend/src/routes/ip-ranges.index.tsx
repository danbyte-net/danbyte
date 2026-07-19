import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type IPRange, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { VrfCell } from "@/components/cells/vrf-cell"
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
import { IpRangeDeleteDialog } from "@/components/ip-range-delete-dialog"
import { StatusBadge } from "@/components/status-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/ip-ranges/")({ component: IpRangesPage })

function IpRangesPage() {
  const [q, setQ] = useState("")
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set())
  const [vrfFilter, setVrfFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<IPRange | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("iprange", "add")
  const canEdit = canDo("iprange", "change")
  const canDelete = canDo("iprange", "delete")

  const query = useQuery({
    queryKey: ["ip-ranges", q],
    queryFn: () =>
      api<Paginated<IPRange>>(
        `/api/ip-ranges/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (
        statusFilter.size > 0 &&
        !statusFilter.has(r.status?.id ?? "__none__")
      )
        return false
      if (vrfFilter.size > 0) {
        const key = r.vrf?.id ?? "__global__"
        if (!vrfFilter.has(key)) return false
      }
      if (tagFilter.size > 0 && !r.tags.some((t) => tagFilter.has(t.slug)))
        return false
      return true
    })
  }, [allRows, statusFilter, vrfFilter, tagFilter])

  const facets = useMemo(() => {
    const status: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    const vrfs: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    for (const r of allRows) {
      const sk = r.status?.id ?? "__none__"
      if (!status[sk])
        status[sk] = {
          name: r.status?.name ?? "No status",
          color: r.status?.color,
          textColor: r.status?.text_color,
          count: 0,
        }
      status[sk].count++
      const vk = r.vrf?.id ?? "__global__"
      if (!vrfs[vk]) vrfs[vk] = { name: r.vrf?.name ?? "Global", count: 0 }
      vrfs[vk].count++
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
      status: Object.entries(status).map<FacetOption>(([value, s]) => ({
        value,
        label: s.name,
        count: s.count,
        color: s.color,
        textColor: s.textColor,
      })),
      vrfs: Object.entries(vrfs)
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

  const handleDelete = useCallback((r: IPRange) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<IPRange>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="IP ranges"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Status"
            options={facets.status}
            selected={statusFilter}
            onToggle={(v) => toggleInSet(statusFilter, v, setStatusFilter)}
          />
          <FacetGroup
            label="VRF"
            options={facets.vrfs}
            selected={vrfFilter}
            onToggle={(v) => toggleInSet(vrfFilter, v, setVrfFilter)}
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
        placeholder: "Filter by address, description…",
      }}
      actions={
        <>
          <TableActions ioType="iprange" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/ip-ranges/new">Add IP range</Link>
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
        tableId="ip-ranges"
      />
      <IpRangeDeleteDialog
        range={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (r: IPRange) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<IPRange>[] {
  return [
    selectionColumn<IPRange>(),
    ...(humanIds ? [numidColumn<IPRange>({ get: (r) => r.numid })] : []),
    {
      id: "range",
      accessorKey: "start_address",
      header: ({ column }) => <SortHeader column={column} label="Range" />,
      cell: ({ row }) => (
        <Link
          to="/ip-ranges/$id"
          params={{ id: row.original.id }}
          className="font-mono text-[13px] font-medium hover:underline"
        >
          {row.original.start_address} – {row.original.end_address}
        </Link>
      ),
    },
    {
      id: "size",
      accessorKey: "size",
      header: ({ column }) => <SortHeader column={column} label="Size" />,
      cell: ({ row }) =>
        row.original.size != null ? (
          <span className="num text-xs">
            {row.original.size.toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "vrf",
      accessorFn: (r) => r.vrf?.name ?? "",
      header: "VRF",
      cell: ({ row }) => <VrfCell vrf={row.original.vrf} />,
    },
    {
      id: "prefix",
      accessorFn: (r) => r.prefix?.cidr ?? "",
      header: "Prefix",
      cell: ({ row }) =>
        row.original.prefix ? (
          <Link
            to="/prefixes/$id"
            params={{ id: row.original.prefix.id }}
            className="font-mono text-xs text-primary hover:underline"
          >
            {row.original.prefix.cidr}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "role",
      accessorFn: (r) => r.role?.name ?? "",
      header: "Role",
      cell: ({ row }) =>
        row.original.role ? (
          <ColorBadge
            name={row.original.role.name}
            color={row.original.role.color || undefined}
          />
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
    tagsColumn<IPRange>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<IPRange>({
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
          editTo={canEdit ? "/ip-ranges/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
