import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Aggregate, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildAggregateColumns } from "@/components/columns/aggregate-columns"
import {
  FilterRail,
  FacetGroup,
  tagObjectsLink,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { AggregateDeleteDialog } from "@/components/aggregate-delete-dialog"
import { useMe } from "@/lib/use-me"
import { useUrlSearch, toggled, useKnown, useUrlSet } from "@/lib/url-filters"

export const Route = createFileRoute("/aggregates/")({
  component: AggregatesPage,
})

function AggregatesPage() {
  const [q, setQ] = useUrlSearch()
  const [rirFilterRaw, setRirFilter] = useUrlSet("rir")
  const [tagFilterRaw, setTagFilter] = useUrlSet("tag")
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

  const handleDelete = useCallback((a: Aggregate) => setDeleting(a), [])
  const columns = useMemo<ColumnDef<Aggregate>[]>(
    () =>
      buildAggregateColumns({
        selection: true,
        humanIds,
        prefixClass: "text-[13px]",
        // A chip toggles its tag in the rail's Tags facet.
        tagFilter: {
          activeSlugs: tagFilter,
          onToggle: (v) => setTagFilter((s) => toggled(s, v)),
        },
        actions: {
          editTo: "/aggregates/$id/edit",
          editParams: (a) => ({ id: a.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds, tagFilter, setTagFilter]
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
