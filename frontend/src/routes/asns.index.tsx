import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { type ASN } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import {
  FilterRail,
  FacetGroup,
  tagObjectsLink,
  type FacetOption,
} from "@/components/filter-rail"
import { AsnDeleteDialog } from "@/components/asn-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { useUrlSearch, toggled, useKnown, useUrlSet } from "@/lib/url-filters"

export const Route = createFileRoute("/asns/")({ component: AsnsPage })

function AsnsPage() {
  const [q, setQ] = useUrlSearch()
  const [rirFilterRaw, setRirFilter] = useUrlSet("rir")
  const [tagFilterRaw, setTagFilter] = useUrlSet("tag")
  const [deleting, setDeleting] = useState<ASN | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("asn", "add")
  const canEdit = canDo("asn", "change")
  const canDelete = canDo("asn", "delete")

  const query = useQuery({
    queryKey: ["asns", q],
    queryFn: () =>
      apiAll<ASN>(
        `/api/asns/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []

  const facets = useMemo(() => {
    const rirs: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      {
        id: number
        name: string
        color?: string
        textColor?: string
        count: number
      }
    > = {}
    for (const a of allRows) {
      const rk = a.rir?.id ?? "__none__"
      if (!rirs[rk]) rirs[rk] = { name: a.rir?.name ?? "-", count: 0 }
      rirs[rk].count++
      for (const t of a.tags) {
        if (!tags[t.slug])
          tags[t.slug] = {
            id: t.id,
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
          link: tagObjectsLink(v.id),
        })),
    }
  }, [allRows])
  // A value no row carries (a stale link) is ignored.
  const rirFilter = useKnown(rirFilterRaw, facets.rirs)
  const tagFilter = useKnown(tagFilterRaw, facets.tags)
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

  const handleDelete = useCallback((a: ASN) => setDeleting(a), [])
  const columns = useMemo<ColumnDef<ASN>[]>(
    () =>
      buildColumns({
        onDelete: handleDelete,
        canEdit,
        canDelete,
        humanIds,
        tagFilter,
        onToggleTag: (v) => setTagFilter((s) => toggled(s, v)),
      }),
    [handleDelete, canEdit, canDelete, humanIds, tagFilter]
  )

  return (
    <ListPageShell
      title="ASNs"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="RIR"
            options={facets.rirs}
            selected={rirFilter}
            onToggle={(v) => setRirFilter((s) => toggled(s, v))}
          />
          <FacetGroup
            label="Tags"
            options={facets.tags}
            selected={tagFilter}
            onToggle={(v) => setTagFilter((s) => toggled(s, v))}
          />
        </FilterRail>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by number, description…",
      }}
      actions={
        <>
          <TableActions ioType="asn" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/asns/new">Add ASN</Link>
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
        tableId="asns"
      />
      <AsnDeleteDialog
        asn={deleting}
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
  tagFilter,
  onToggleTag,
}: {
  onDelete: (a: ASN) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
  tagFilter: Set<string>
  onToggleTag: (slug: string) => void
}): ColumnDef<ASN>[] {
  return [
    selectionColumn<ASN>(),
    ...(humanIds ? [numidColumn<ASN>({ get: (r) => r.numid })] : []),
    {
      id: "asn",
      accessorKey: "asn",
      header: ({ column }) => <SortHeader column={column} label="ASN" />,
      cell: ({ row }) => (
        <Link
          to="/asns/$id"
          params={{ id: row.original.id }}
          className="link font-mono text-[13px] font-medium"
        >
          AS{row.original.asn}
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
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "sites",
      header: "Sites",
      enableSorting: false,
      cell: ({ row }) => {
        const sites = row.original.sites
        if (sites.length === 0)
          return <span className="text-muted-foreground">-</span>
        return (
          <span className="text-xs text-muted-foreground">
            {sites.map((s) => s.name).join(", ")}
          </span>
        )
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    },
    tagsColumn<ASN>({
      getTags: (r) => r.tags,
      activeSlugs: tagFilter,
      onToggle: onToggleTag,
    }),
    timeAgoColumn<ASN>({
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
          editTo={canEdit ? "/asns/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
