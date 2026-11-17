import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { AccessoryType } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { useUrlTableFilters } from "@/components/table-filters"
import { buildPluggableColumns } from "@/components/columns/pluggable-columns"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"

export const Route = createFileRoute("/pluggables/")({
  component: PluggablesPage,
})

/**
 * DCIM → Catalog → Pluggables (docs/dcim/pluggables.md): the transceivers,
 * plugs and cords model packs bring, with how many ports show each.
 */
function PluggablesPage() {
  const [q, setQ] = useUrlSearch()
  const { canDo } = useMe()
  const canEdit = canDo("moduletype", "change")
  const canDelete = canDo("moduletype", "delete")
  const [deleting, setDeleting] = useState<AccessoryType | null>(null)

  const query = useQuery({
    queryKey: ["pluggables", q],
    queryFn: () =>
      apiAll<AccessoryType>(
        `/api/accessory-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const onDelete = useCallback((r: AccessoryType) => setDeleting(r), [])
  const columns = useMemo<ColumnDef<AccessoryType, unknown>[]>(
    () =>
      buildPluggableColumns({
        actions:
          canEdit || canDelete
            ? { canEdit, onDelete: canDelete ? onDelete : undefined }
            : undefined,
      }),
    [canEdit, canDelete, onDelete]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Pluggables"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "accessorytype",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, part number…",
      }}
      query={query}
    >
      {rows.length === 0 && !q ? (
        <p className="max-w-xl text-sm text-muted-foreground">
          No pluggables yet. They come with 3D model packs.
        </p>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          flexColumn="fits"
          tableId="pluggables"
        />
      )}
      <PluggableDeleteDialog
        part={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

/** Delete a pluggable nothing uses (the server refuses one in use). */
export function PluggableDeleteDialog({
  part,
  onOpenChange,
  onDeleted,
}: {
  part: AccessoryType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/accessory-types/${part!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${part!.name}`)
      qc.invalidateQueries({ queryKey: ["pluggables"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const used = part?.in_use ?? 0
  return (
    <AlertDialog open={!!part} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {part?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {used > 0
              ? `${used} port${used === 1 ? "" : "s"} or record${used === 1 ? "" : "s"} use this part.`
              : "Removes this part and its 3D model. A pack re-import brings it back."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || used > 0}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
