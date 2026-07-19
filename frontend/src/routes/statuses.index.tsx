import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, STATUSABLE_MODELS, type Status, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { Slider } from "@/components/ui/slider"
import { LocalityBadge } from "@/components/locality-badge"
import { IpStatusDeleteDialog } from "@/components/ip-status-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/statuses/")({
  component: IpStatusesPage,
})

const MODEL_LABELS: Record<string, string> = Object.fromEntries(
  STATUSABLE_MODELS.map((m) => [m.value, m.label])
)

const labelFor = (slug: string) => MODEL_LABELS[slug] ?? slug

function flagsOf(s: Status): string[] {
  const f: string[] = []
  if (s.is_available) f.push("available")
  if (s.requires_note) f.push("requires-note")
  return f
}

function IpStatusesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("ipstatus", "add")
  const canEdit = canDo("ipstatus", "change")
  const canDelete = canDo("ipstatus", "delete")
  const [q, setQ] = useState("")
  const [flagFilter, setFlagFilter] = useState<Set<string>>(new Set())
  const [usedBy, setUsedBy] = useState<Set<string>>(new Set())
  const [defaulted, setDefaulted] = useState<Set<string>>(new Set())
  const [weightRange, setWeightRange] = useState<[number, number] | null>(null)
  const [deleting, setDeleting] = useState<Status | null>(null)

  const query = useQuery({
    queryKey: ["statuses", q],
    queryFn: () =>
      api<Paginated<Status>>(
        `/api/statuses/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter((s) => {
        if (flagFilter.size > 0) {
          const f = flagsOf(s)
          if (![...flagFilter].every((x) => f.includes(x))) return false
        }
        if (
          usedBy.size > 0 &&
          ![...usedBy].some((m) => s.available_to.includes(m))
        )
          return false
        if (defaulted.size === 1) {
          const has = (s.default_for?.length ?? 0) > 0
          if (defaulted.has("yes") !== has) return false
        }
        if (
          weightRange &&
          (s.weight < weightRange[0] || s.weight > weightRange[1])
        )
          return false
        return true
      }),
    [allRows, flagFilter, usedBy, defaulted, weightRange]
  )

  const facets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of allRows) for (const f of flagsOf(s)) c[f] = (c[f] ?? 0) + 1
    return [
      { value: "available", label: "Available", count: c["available"] ?? 0 },
      {
        value: "requires-note",
        label: "Requires note",
        count: c["requires-note"] ?? 0,
      },
    ].filter((o) => o.count) as FacetOption[]
  }, [allRows])

  const usedByFacets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const s of allRows)
      for (const m of s.available_to) c[m] = (c[m] ?? 0) + 1
    return Object.entries(c)
      .map(([value, count]) => ({ value, label: labelFor(value), count }))
      .sort((a, b) => a.label.localeCompare(b.label)) as FacetOption[]
  }, [allRows])

  const defaultFacets = useMemo(() => {
    let yes = 0
    for (const s of allRows) if ((s.default_for?.length ?? 0) > 0) yes++
    return [
      { value: "yes", label: "Is a default", count: yes },
      { value: "no", label: "Not a default", count: allRows.length - yes },
    ].filter((o) => o.count) as FacetOption[]
  }, [allRows])

  const weightBounds = useMemo<[number, number]>(() => {
    if (allRows.length === 0) return [0, 100]
    const ws = allRows.map((s) => s.weight)
    return [Math.min(...ws), Math.max(...ws)]
  }, [allRows])

  const handleDelete = useCallback((s: Status) => setDeleting(s), [])
  const columns = useMemo<ColumnDef<Status>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Statuses"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Used by"
            options={usedByFacets}
            selected={usedBy}
            onToggle={(v) => toggleInSet(usedBy, v, setUsedBy)}
          />
          <FacetGroup
            label="Default"
            options={defaultFacets}
            selected={defaulted}
            onToggle={(v) => toggleInSet(defaulted, v, setDefaulted)}
          />
          <FacetGroup
            label="Flags"
            options={facets}
            selected={flagFilter}
            onToggle={(v) => toggleInSet(flagFilter, v, setFlagFilter)}
          />
          {weightBounds[0] !== weightBounds[1] && (
            <div className="space-y-2 px-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
                  Weight
                </span>
                {weightRange && (
                  <button
                    className="text-[11px] text-primary hover:underline"
                    onClick={() => setWeightRange(null)}
                  >
                    Reset
                  </button>
                )}
              </div>
              <Slider
                min={weightBounds[0]}
                max={weightBounds[1]}
                step={1}
                value={weightRange ?? weightBounds}
                onValueChange={(v) =>
                  setWeightRange([v[0], v[1]] as [number, number])
                }
              />
              <div className="num flex justify-between text-[11px] text-muted-foreground">
                <span>{(weightRange ?? weightBounds)[0]}</span>
                <span>{(weightRange ?? weightBounds)[1]}</span>
              </div>
            </div>
          )}
        </FilterRail>
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="ipstatus" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/statuses/new">Add status</Link>
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
        tableId="statuses"
      />
      <IpStatusDeleteDialog
        status={deleting}
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
  onDelete: (s: Status) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<Status>[] {
  return [
    selectionColumn<Status>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/statuses/$id"
          params={{ id: row.original.id }}
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
      id: "available_to",
      header: "Available to",
      enableSorting: false,
      cell: ({ row }) => {
        const types = row.original.available_to
        const defaults = row.original.default_for
        if (!types.length)
          return <span className="text-muted-foreground">—</span>
        return (
          <span className="flex flex-col gap-0.5">
            <span className="flex flex-wrap gap-1">
              {types.map((t) => (
                <span
                  key={t}
                  className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
                >
                  {labelFor(t)}
                </span>
              ))}
            </span>
            {defaults.length > 0 && (
              <span className="text-[10px] text-muted-foreground">
                default for {defaults.map(labelFor).join(", ")}
              </span>
            )}
          </span>
        )
      },
    },
    {
      id: "flags",
      header: "Flags",
      enableSorting: false,
      cell: ({ row }) => {
        const f = flagsOf(row.original)
        return f.length ? (
          <span className="flex flex-wrap gap-1">
            {f.map((x) => (
              <span
                key={x}
                className="rounded-sm bg-muted px-1.5 py-0.5 text-[11px]"
              >
                {x}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
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
    {
      id: "usage",
      accessorKey: "usage_count",
      header: ({ column }) => <SortHeader column={column} label="IPs" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.usage_count}</span>
      ),
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
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
    },
    timeAgoColumn<Status>({
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
          editTo={
            objCan(row.original, "change", canEdit)
              ? "/statuses/$id/edit"
              : undefined
          }
          editParams={{ id: row.original.id }}
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
