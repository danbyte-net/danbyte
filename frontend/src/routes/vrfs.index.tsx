import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VRF } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildVrfColumns } from "@/components/columns/vrf-columns"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { VrfDeleteDialog } from "@/components/vrf-delete-dialog"
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
      buildVrfColumns<VRF>({
        selection: true,
        humanIds,
        violations: true,
        actions: {
          editTo: "/vrfs/$id/edit",
          editParams: (v) => ({ id: v.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
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
