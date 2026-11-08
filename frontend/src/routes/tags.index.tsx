import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Merge } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Tag, TagDuplicates } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { GlobalTagChip } from "@/components/cells/global-tag-chip"
import {
  FilterRail,
  FacetGroup,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { LocalityBadge } from "@/components/locality-badge"
import { TagDeleteDialog } from "@/components/tag-delete-dialog"
import { TagMergeDialog } from "@/components/tag-merge-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"
import { useUrlSearch, toggled, useKnown, useUrlSet } from "@/lib/url-filters"

export const Route = createFileRoute("/tags/")({ component: TagsPage })

function TagsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("tag", "add")
  const canEdit = canDo("tag", "change")
  const canDelete = canDo("tag", "delete")
  const [q, setQ] = useUrlSearch()
  const [usageFilterRaw, setUsageFilter] = useUrlSet("usage")
  const [colorFilterRaw, setColorFilter] = useUrlSet("color")
  const [namesFilterRaw, setNamesFilter] = useUrlSet("names")
  const [deleting, setDeleting] = useState<Tag | null>(null)
  const [merging, setMerging] = useState<Tag | null>(null)

  const query = useQuery({
    queryKey: ["tags", q],
    queryFn: () =>
      apiAll<Tag>(
        `/api/tags/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []
  // Names used more than once among the tags this tenant sees - pairs from
  // before names were unique, left to merge.
  const dupQuery = useQuery({
    queryKey: ["tags", "duplicates"],
    queryFn: () => api<TagDuplicates>("/api/tags/duplicates/"),
  })
  const dupGroups = useMemo(() => dupQuery.data?.results ?? [], [dupQuery.data])
  const dupIds = useMemo(
    () => new Set(dupGroups.flatMap((g) => g.ids)),
    [dupGroups]
  )

  const facets = useMemo(() => {
    let colored = 0
    let uncolored = 0
    let used = 0
    let unused = 0
    for (const t of allRows) {
      t.color ? colored++ : uncolored++
      ;(t.usage_count ?? 0) > 0 ? used++ : unused++
    }
    const dups = allRows.filter((t) => dupIds.has(t.id)).length
    return {
      names: [{ value: "duplicate", label: "Used twice", count: dups }].filter(
        (o) => o.count
      ),
      usage: [
        { value: "used", label: "In use", count: used },
        { value: "unused", label: "Unused", count: unused },
      ].filter((o) => o.count) as FacetOption[],
      color: [
        { value: "colored", label: "Colored", count: colored },
        { value: "uncolored", label: "No color", count: uncolored },
      ].filter((o) => o.count) as FacetOption[],
    }
  }, [allRows, dupIds])
  // A value no row carries (a stale link) is ignored.
  const usageFilter = useKnown(usageFilterRaw, facets.usage)
  const colorFilter = useKnown(colorFilterRaw, facets.color)
  const namesFilter = useKnown(namesFilterRaw, facets.names)
  const rows = useMemo(() => {
    const filtered = allRows.filter((t) => {
      if (namesFilter.has("duplicate") && !dupIds.has(t.id)) return false
      if (usageFilter.size > 0) {
        const used = (t.usage_count ?? 0) > 0
        if (!(
          (usageFilter.has("used") && used) ||
          (usageFilter.has("unused") && !used)
        ))
          return false
      }
      if (colorFilter.size > 0) {
        const colored = !!t.color
        if (!(
          (colorFilter.has("colored") && colored) ||
          (colorFilter.has("uncolored") && !colored)
        ))
          return false
      }
      return true
    })
    // The pairs side by side.
    if (namesFilter.has("duplicate"))
      filtered.sort((a, b) =>
        a.name.trim().toLowerCase().localeCompare(b.name.trim().toLowerCase())
      )
    return filtered
  }, [allRows, usageFilter, colorFilter, namesFilter, dupIds])

  const handleDelete = useCallback((t: Tag) => setDeleting(t), [])
  const handleMerge = useCallback((t: Tag) => setMerging(t), [])
  const columns = useMemo<ColumnDef<Tag>[]>(
    () =>
      buildColumns({
        onDelete: handleDelete,
        onMerge: handleMerge,
        canEdit,
        canDelete,
      }),
    [handleDelete, handleMerge, canEdit, canDelete]
  )

  const twice = dupGroups.every((g) => g.ids.length === 2)
  const notice = dupGroups.length > 0 && (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] text-amber-800 dark:text-amber-300">
      <span>
        {dupGroups.length} tag name{dupGroups.length === 1 ? " is" : "s are"}{" "}
        used {twice ? "twice" : "more than once"}
      </span>
      {!namesFilter.has("duplicate") && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          onClick={() => setNamesFilter(new Set(["duplicate"]))}
        >
          Show
        </Button>
      )}
    </div>
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Names"
        options={facets.names}
        selected={namesFilter}
        onToggle={(v) => setNamesFilter((s) => toggled(s, v))}
      />
      <FacetGroup
        label="Usage"
        options={facets.usage}
        selected={usageFilter}
        onToggle={(v) => setUsageFilter((s) => toggled(s, v))}
      />
      <FacetGroup
        label="Color"
        options={facets.color}
        selected={colorFilter}
        onToggle={(v) => setColorFilter((s) => toggled(s, v))}
      />
    </FilterRail>
  )

  return (
    <ListPageShell
      title="Tags"
      count={query.data ? rows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/tags/new">Add tag</Link>
            </Button>
          )}
        </>
      }
      query={query}
      summary={notice || undefined}
    >
      <DataTable data={rows} columns={columns} tableId="tags" />
      <TagDeleteDialog
        tag={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <TagMergeDialog
        tag={merging}
        tags={allRows}
        onOpenChange={(o) => !o && setMerging(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  onMerge,
  canEdit,
  canDelete,
}: {
  onDelete: (t: Tag) => void
  onMerge: (t: Tag) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<Tag>[] {
  return [
    selectionColumn<Tag>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/tags/$id"
          params={{ id: String(row.original.id) }}
          className="inline-flex items-center hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
          {row.original.is_global && <GlobalTagChip className="ml-1" />}
        </Link>
      ),
    },
    {
      id: "color",
      accessorKey: "color",
      header: "Color",
      cell: ({ row }) =>
        row.original.color ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-sm border border-border"
              style={{ backgroundColor: row.original.color }}
            />
            <span className="font-mono text-xs">{row.original.color}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "usage",
      accessorFn: (r) => r.usage_count ?? 0,
      header: ({ column }) => <SortHeader column={column} label="Usage" />,
      cell: ({ row }) => {
        const u = row.original.usage_count ?? 0
        return u > 0 ? (
          <span className="num text-xs">
            {u} object{u === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-muted-foreground">unused</span>
        )
      },
    },
    {
      id: "scope",
      accessorFn: (r) => r.owning_site?.name ?? "",
      header: "Scope",
      cell: ({ row }) =>
        row.original.is_global ? (
          <Badge
            variant="secondary"
            className="text-[11px] font-normal text-muted-foreground"
          >
            All tenants
          </Badge>
        ) : (
          <LocalityBadge owningSite={row.original.owning_site} />
        ),
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          extra={
            canEdit && objCan(row.original, "delete", canDelete) ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={() => onMerge(row.original)}
                  >
                    <Merge className="h-3.5 w-3.5" />
                    <span className="sr-only">Merge into…</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent variant="panel">Merge into…</TooltipContent>
              </Tooltip>
            ) : undefined
          }
          editTo={
            objCan(row.original, "change", canEdit)
              ? "/tags/$id/edit"
              : undefined
          }
          editParams={{ id: String(row.original.id) }}
          onDelete={
            objCan(row.original, "delete", canDelete)
              ? () => onDelete(row.original)
              : undefined
          }
        />
      ),
    },
  ]
}
