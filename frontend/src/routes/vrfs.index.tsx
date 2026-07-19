import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VRF } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { ColorBadge } from "@/components/cells/color-badge"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { VrfDeleteDialog } from "@/components/vrf-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vrfs/")({ component: VrfsPage })

function VrfsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("vrf", "add")
  const canEdit = canDo("vrf", "change")
  const canDelete = canDo("vrf", "delete")
  const [q, setQ] = useState("")
  const [rtFilter, setRtFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [usageFilter, setUsageFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<VRF | null>(null)

  const query = useQuery({
    queryKey: ["vrfs", q],
    queryFn: () =>
      api<Paginated<VRF>>(
        `/api/vrfs/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((v) => {
      if (rtFilter.size > 0) {
        const rtIds = new Set(
          [...v.import_targets, ...v.export_targets].map((t) => t.id)
        )
        if (![...rtFilter].some((id) => rtIds.has(id))) return false
      }
      if (tagFilter.size > 0 && !v.tags.some((t) => tagFilter.has(t.slug)))
        return false
      if (usageFilter.size > 0) {
        const key = v.prefix_count > 0 ? "in-use" : "empty"
        if (!usageFilter.has(key)) return false
      }
      return true
    })
  }, [allRows, rtFilter, tagFilter, usageFilter])

  const facets = useMemo(() => {
    const rts: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    const usage: Record<string, number> = {}
    for (const v of allRows) {
      for (const rt of [...v.import_targets, ...v.export_targets]) {
        if (!rts[rt.id]) rts[rt.id] = { name: rt.name, count: 0 }
        rts[rt.id].count++
      }
      for (const t of v.tags) {
        if (!tags[t.slug])
          tags[t.slug] = {
            name: t.name,
            color: t.color,
            textColor: t.text_color,
            count: 0,
          }
        tags[t.slug].count++
      }
      const u = v.prefix_count > 0 ? "in-use" : "empty"
      usage[u] = (usage[u] ?? 0) + 1
    }
    return {
      rts: Object.entries(rts)
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
      usage: (["in-use", "empty"] as const)
        .filter((k) => usage[k])
        .map<FacetOption>((k) => ({
          value: k,
          label: k === "in-use" ? "Has prefixes" : "Empty",
          count: usage[k],
        })),
    }
  }, [allRows])

  const handleDelete = useCallback((v: VRF) => setDeleting(v), [])

  const columns = useMemo<ColumnDef<VRF>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="VRFs"
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
            label="Route targets"
            options={facets.rts}
            selected={rtFilter}
            onToggle={(v) => toggleInSet(rtFilter, v, setRtFilter)}
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
        placeholder: "Filter by name, RD, description…",
      }}
      actions={
        <>
          <TableActions ioType="vrf" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/vrfs/new">Add VRF</Link>
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
        tableId="vrfs"
      />
      <VrfDeleteDialog
        vrf={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

interface ColumnOpts {
  onDelete: (v: VRF) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: ColumnOpts): ColumnDef<VRF>[] {
  return [
    selectionColumn<VRF>(),
    ...(humanIds ? [numidColumn<VRF>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1.5">
          <Link
            to="/vrfs/$id"
            params={{ id: row.original.id }}
            className="hover:opacity-90"
          >
            <ColorBadge
              name={row.original.name}
              color={row.original.color || undefined}
            />
          </Link>
          <ViolationBadge objectId={row.original.id} />
        </span>
      ),
    },
    {
      id: "rd",
      accessorKey: "rd",
      header: ({ column }) => <SortHeader column={column} label="RD" />,
      cell: ({ row }) =>
        row.original.rd ? (
          <span className="font-mono text-xs">{row.original.rd}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "import_targets",
      header: "Import",
      enableSorting: false,
      cell: ({ row }) => <RtCell rts={row.original.import_targets} />,
    },
    {
      id: "export_targets",
      header: "Export",
      enableSorting: false,
      cell: ({ row }) => <RtCell rts={row.original.export_targets} />,
    },
    {
      id: "prefixes",
      accessorKey: "prefix_count",
      header: ({ column }) => <SortHeader column={column} label="Prefixes" />,
      cell: ({ row }) =>
        row.original.prefix_count > 0 ? (
          <span className="num text-xs">{row.original.prefix_count}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "ips",
      accessorKey: "ip_count",
      header: ({ column }) => <SortHeader column={column} label="IPs" />,
      cell: ({ row }) =>
        row.original.ip_count > 0 ? (
          <span className="num text-xs">{row.original.ip_count}</span>
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
    tagsColumn<VRF>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<VRF>({
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
          editTo={canEdit ? "/vrfs/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

function RtCell({ rts }: { rts: { id: string; name: string }[] }) {
  if (rts.length === 0) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-nowrap items-center gap-1 overflow-hidden">
      {rts.map((rt) => (
        <span
          key={rt.id}
          className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {rt.name}
        </span>
      ))}
    </div>
  )
}
