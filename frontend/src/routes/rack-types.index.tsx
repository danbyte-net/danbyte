import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, RackType } from "@/lib/api"
import { Button } from "@/components/ui/button"
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
import { DataTable } from "@/components/data-table"
import { buildRackTypeColumns } from "@/components/columns/rack-type-columns"
import { ListPageShell } from "@/components/list-page-shell"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/rack-types/")({
  component: RackTypesPage,
})

function RackTypesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<RackType | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("racktype", "add")
  const canEdit = canDo("racktype", "change")
  const canDelete = canDo("racktype", "delete")

  const query = useQuery({
    queryKey: ["rack-types", q],
    queryFn: () =>
      api<Paginated<RackType>>(
        `/api/rack-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((rt: RackType) => setDeleting(rt), [])
  const columns = useMemo<ColumnDef<RackType, unknown>[]>(
    () =>
      buildRackTypeColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: canEdit ? "/rack-types/$id/edit" : undefined,
          editParams: (rt) => ({ id: rt.id }),
          onDelete: canDelete ? handleDelete : undefined,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Rack types"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, manufacturer…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/rack-types/new">Add rack type</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      {rows.length === 0 ? (
        <p className="max-w-xl text-sm text-muted-foreground">
          No rack types yet. A rack type is a cabinet model — picking one on a
          rack pre-fills its dimensions, and the type's accessory strips
          (vertical PDUs) can be stamped onto new racks automatically.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="rack-types"
        />
      )}
      <RackTypeDeleteDialog
        rackType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

export function RackTypeDeleteDialog({
  rackType,
  onOpenChange,
  onDeleted,
}: {
  rackType: RackType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/rack-types/${rackType!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rackType!.name}`)
      qc.invalidateQueries({ queryKey: ["rack-types"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const used = rackType?.rack_count ?? 0
  return (
    <AlertDialog open={!!rackType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {rackType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {used > 0
              ? `${used} rack${used === 1 ? "" : "s"} use this type — unassign them first.`
              : "Removes this rack model and its accessory list. Racks and devices are never touched."}
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
