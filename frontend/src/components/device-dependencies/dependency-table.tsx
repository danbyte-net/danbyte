import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import type { DeviceDependency } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { buildDeviceDependencyColumns } from "@/components/columns/device-dependency-columns"
import type { DeviceDependencyColumnId } from "@/components/columns/device-dependency-columns"
import { DeviceDependencyDialog } from "@/components/device-dependencies/dependency-dialog"
import { DeviceDependencyDeleteDialog } from "@/components/device-dependencies/dependency-delete-dialog"

/** The dependencies matching ``filter`` (e.g. ``{medium: id}``) as an
 * embedded table - a catalog page's tab. Edit and delete in place. */
export function DeviceDependencyTable({
  filter,
  omit,
}: {
  filter: Record<string, string>
  omit?: DeviceDependencyColumnId[]
}) {
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("devicedependency", "change")
  const canDelete = canDo("devicedependency", "delete")
  const [editing, setEditing] = useState<DeviceDependency | null>(null)
  const [deleting, setDeleting] = useState<DeviceDependency | null>(null)
  const qs = new URLSearchParams(filter).toString()
  const q = useQuery({
    queryKey: ["device-dependencies", "embedded", qs],
    queryFn: () => apiAll<DeviceDependency>(`/api/device-dependencies/?${qs}`),
  })
  const columns = useMemo(
    () =>
      buildDeviceDependencyColumns({
        omit,
        humanIds,
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [omit, humanIds, canEdit, canDelete]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState title="No dependencies." />
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="medium-dependencies"
          embedded
          searchable
          searchPlaceholder="Search dependencies…"
        />
      )}
      {editing && (
        <DeviceDependencyDialog
          mode={{ kind: "edit", dependency: editing }}
          open
          onOpenChange={(o) => !o && setEditing(null)}
        />
      )}
      <DeviceDependencyDeleteDialog
        dependency={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </>
  )
}
