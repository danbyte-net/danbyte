import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type IPRole, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { ColorBadge } from "@/components/cells/color-badge"
import { timeAgoColumn } from "@/components/cells/time-ago"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { IpRoleDeleteDialog } from "@/components/ip-role-delete-dialog"
import { LocalityBadge } from "@/components/locality-badge"
import { RowActions } from "@/components/row-actions"
import { useMe, objCan } from "@/lib/use-me"

export const Route = createFileRoute("/ip-roles/")({ component: IpRolesPage })

function flagsOf(r: IPRole): string[] {
  const f: string[] = []
  if (r.is_gateway) f.push("gateway")
  if (r.is_virtual) f.push("virtual")
  return f
}

function IpRolesPage() {
  const { canDo } = useMe()
  const canAdd = canDo("iprole", "add")
  const canEdit = canDo("iprole", "change")
  const canDelete = canDo("iprole", "delete")
  const [q, setQ] = useState("")
  const [flagFilter, setFlagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<IPRole | null>(null)

  const query = useQuery({
    queryKey: ["ip-roles", q],
    queryFn: () =>
      api<Paginated<IPRole>>(
        `/api/ip-roles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter((r) => {
        if (flagFilter.size === 0) return true
        const f = flagsOf(r)
        return [...flagFilter].every((x) => f.includes(x))
      }),
    [allRows, flagFilter]
  )

  const facets = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of allRows) for (const f of flagsOf(r)) c[f] = (c[f] ?? 0) + 1
    return [
      { value: "gateway", label: "Gateway", count: c["gateway"] ?? 0 },
      { value: "virtual", label: "Virtual", count: c["virtual"] ?? 0 },
    ].filter((o) => o.count) as FacetOption[]
  }, [allRows])

  const handleDelete = useCallback((r: IPRole) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<IPRole>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="IP roles"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Flags"
            options={facets}
            selected={flagFilter}
            onToggle={(v) => toggleInSet(flagFilter, v, setFlagFilter)}
          />
        </FilterRail>
      }
      search={{ value: q, onChange: setQ, placeholder: "Filter…" }}
      actions={
        <>
          <TableActions ioType="iprole" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/ip-roles/new">Add role</Link>
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
        tableId="ip-roles"
      />
      <IpRoleDeleteDialog
        role={deleting}
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
  onDelete: (r: IPRole) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<IPRole>[] {
  return [
    selectionColumn<IPRole>(),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/ip-roles/$id"
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
    timeAgoColumn<IPRole>({
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
              ? "/ip-roles/$id/edit"
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
