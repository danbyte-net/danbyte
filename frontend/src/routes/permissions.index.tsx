import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { ObjectPermission } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildPermissionColumns } from "@/components/columns/permission-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { BulkFlagActions } from "@/components/bulk-flag-actions"
import { PermissionDeleteDialog } from "@/components/permission-delete-dialog"
import { SiteRoleDialog } from "@/components/site-role-dialog"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/permissions/")({
  component: PermissionsPage,
})

const ENDPOINT = "/api/object-permissions/"
const NOUN: [string, string] = ["permission", "permissions"]

function PermissionsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<ObjectPermission | null>(null)
  const [siteRoleOpen, setSiteRoleOpen] = useState(false)
  const { canDo } = useMe()
  const canAdd = canDo("objectpermission", "add")
  const canEdit = canDo("objectpermission", "change")
  const canDelete = canDo("objectpermission", "delete")

  const query = useQuery({
    queryKey: ["object-permissions"],
    queryFn: () => apiAll<ObjectPermission>("/api/object-permissions/"),
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

  const selectable = canEdit || canDelete
  const [selected, setSelected] = useState<ObjectPermission[]>([])
  const clear = () => setSelected([])
  const handleDelete = useCallback((p: ObjectPermission) => setDeleting(p), [])
  const columns = useMemo(
    () =>
      buildPermissionColumns({
        selection: selectable,
        actions: {
          editTo: "/permissions/$id/edit",
          editParams: (p) => ({ id: p.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, selectable]
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
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint={ENDPOINT}
        noun={NOUN}
        invalidate={[["object-permissions"]]}
        onCleared={clear}
        canEdit={canEdit}
        canDelete={canDelete}
        actions={
          canEdit && (
            <BulkFlagActions
              endpoint={ENDPOINT}
              field="enabled"
              ids={selected.map((p) => p.id)}
              noun={NOUN}
              invalidate={[["object-permissions"]]}
              onDone={clear}
            />
          )
        }
      />
      <PermissionDeleteDialog
        permission={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SiteRoleDialog open={siteRoleOpen} onOpenChange={setSiteRoleOpen} />
    </ListPageShell>
  )
}
