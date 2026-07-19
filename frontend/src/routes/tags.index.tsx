import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Tag } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { LocalityBadge } from "@/components/locality-badge"
import { TagDeleteDialog } from "@/components/tag-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/tags/")({ component: TagsPage })

function TagsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("tag", "add")
  const canEdit = canDo("tag", "change")
  const canDelete = canDo("tag", "delete")
  const [q, setQ] = useState("")
  const [usageFilter, setUsageFilter] = useState<Set<string>>(new Set())
  const [colorFilter, setColorFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<Tag | null>(null)

  const query = useQuery({
    queryKey: ["tags", q],
    queryFn: () =>
      api<Paginated<Tag>>(
        `/api/tags/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(() => {
    return allRows.filter((t) => {
      if (usageFilter.size > 0) {
        const used = (t.usage_count ?? 0) > 0
        if (
          !(
            (usageFilter.has("used") && used) ||
            (usageFilter.has("unused") && !used)
          )
        )
          return false
      }
      if (colorFilter.size > 0) {
        const colored = !!t.color
        if (
          !(
            (colorFilter.has("colored") && colored) ||
            (colorFilter.has("uncolored") && !colored)
          )
        )
          return false
      }
      return true
    })
  }, [allRows, usageFilter, colorFilter])

  const facets = useMemo(() => {
    let colored = 0
    let uncolored = 0
    let used = 0
    let unused = 0
    for (const t of allRows) {
      t.color ? colored++ : uncolored++
      ;(t.usage_count ?? 0) > 0 ? used++ : unused++
    }
    return {
      usage: [
        { value: "used", label: "In use", count: used },
        { value: "unused", label: "Unused", count: unused },
      ].filter((o) => o.count) as FacetOption[],
      color: [
        { value: "colored", label: "Colored", count: colored },
        { value: "uncolored", label: "No color", count: uncolored },
      ].filter((o) => o.count) as FacetOption[],
    }
  }, [allRows])

  const handleDelete = useCallback((t: Tag) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<Tag>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Usage"
        options={facets.usage}
        selected={usageFilter}
        onToggle={(v) => toggleInSet(usageFilter, v, setUsageFilter)}
      />
      <FacetGroup
        label="Color"
        options={facets.color}
        selected={colorFilter}
        onToggle={(v) => toggleInSet(colorFilter, v, setColorFilter)}
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
    >
      <DataTable data={rows} columns={columns} tableId="tags" />
      <TagDeleteDialog
        tag={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (t: Tag) => void
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
          className="hover:opacity-90"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
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
          <span className="text-muted-foreground">—</span>
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
      cell: ({ row }) => (
        <LocalityBadge owningSite={row.original.owning_site} />
      ),
    },
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
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
