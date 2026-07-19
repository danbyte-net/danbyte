import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type ObjectPermission, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { PermissionDeleteDialog } from "@/components/permission-delete-dialog"
import { SiteRoleDialog } from "@/components/site-role-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/permissions/")({
  component: PermissionsPage,
})

function PermissionsPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ObjectPermission | null>(null)
  const [siteRoleOpen, setSiteRoleOpen] = useState(false)
  const { canDo } = useMe()
  const canAdd = canDo("objectpermission", "add")
  const canEdit = canDo("objectpermission", "change")
  const canDelete = canDo("objectpermission", "delete")

  const query = useQuery({
    queryKey: ["object-permissions"],
    queryFn: () => api<Paginated<ObjectPermission>>("/api/object-permissions/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allRows
    return allRows.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.description.toLowerCase().includes(needle) ||
        p.object_types.some((t) => t.toLowerCase().includes(needle))
    )
  }, [allRows, q])

  const handleDelete = useCallback((p: ObjectPermission) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<ObjectPermission>[]>(
    () => buildColumns({ onDelete: handleDelete, canEdit, canDelete }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Permissions"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter permissions…",
      }}
      actions={
        <>
          {canAdd && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSiteRoleOpen(true)}
            >
              Site role
            </Button>
          )}
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/permissions/new">Add permission</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="object_types"
        tableId="permissions"
      />
      <PermissionDeleteDialog
        permission={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SiteRoleDialog open={siteRoleOpen} onOpenChange={setSiteRoleOpen} />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
}: {
  onDelete: (p: ObjectPermission) => void
  canEdit: boolean
  canDelete: boolean
}): ColumnDef<ObjectPermission>[] {
  return [
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/permissions/$id/edit"
          params={{ id: row.original.id }}
          className="flex items-center gap-2 font-medium hover:underline"
        >
          {row.original.name}
          {!row.original.enabled && (
            <Badge variant="secondary" className="text-[10px]">
              disabled
            </Badge>
          )}
        </Link>
      ),
    },
    {
      id: "actions_granted",
      accessorFn: (p) => p.actions.join(", "),
      header: "Actions",
      cell: ({ row }) => (
        <span className="font-mono text-[11px] text-muted-foreground">
          {row.original.actions.join(" · ") || "—"}
        </span>
      ),
    },
    {
      id: "object_types",
      accessorFn: (p) => p.object_types.join(", "),
      header: "Object types",
      cell: ({ row }) => {
        const ts = row.original.object_types
        const label = ts.includes("*")
          ? "All object types"
          : ts.join(", ") || "—"
        return (
          <span className="line-clamp-1 block font-mono text-[11px] text-muted-foreground">
            {label}
          </span>
        )
      },
    },
    {
      id: "scope",
      accessorFn: (p) => p.tenants.map((t) => t.name).join(", "),
      header: "Tenant scope",
      cell: ({ row }) =>
        row.original.tenants.length ? (
          <span className="text-xs">
            {row.original.tenants.map((t) => t.name).join(", ")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">All</span>
        ),
    },
    {
      id: "assigned",
      header: "Assigned to",
      cell: ({ row }) => {
        const g = row.original.groups.length
        const u = row.original.users.length
        const parts: string[] = []
        if (g) parts.push(`${g} group${g > 1 ? "s" : ""}`)
        if (u) parts.push(`${u} user${u > 1 ? "s" : ""}`)
        return (
          <span className="text-xs text-muted-foreground">
            {parts.join(" · ") || "—"}
          </span>
        )
      },
    },
    {
      id: "constraints",
      header: "Constraints",
      cell: ({ row }) =>
        row.original.constraints != null ? (
          <Badge variant="secondary" className="text-[10px]">
            scoped
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "row_actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/permissions/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
