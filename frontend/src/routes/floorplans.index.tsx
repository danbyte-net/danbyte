import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type { FloorPlanStack } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildFloorPlanStackColumns } from "@/components/columns/floor-plan-stack-columns"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/floorplans/")({
  component: FloorPlansPage,
})

/** Maps → Floor plans: one row per floor plan (a building or hall), with its
 * floor count; a row opens its last-viewed or first floor. */
function FloorPlansPage() {
  const { canDo } = useMe()
  const canAdd = canDo("floorplan", "add")
  const canDelete = canDo("floorplan", "delete")
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<FloorPlanStack | null>(null)

  const query = useQuery({
    queryKey: ["floor-plan-stacks", q],
    queryFn: () =>
      apiAll<FloorPlanStack>(
        `/api/floor-plan-stacks/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const columns = useMemo(
    () =>
      buildFloorPlanStackColumns({
        selection: true,
        actions: {
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [canDelete]
  )

  return (
    <ListPageShell
      title="Floor plans"
      count={query.data ? rows.length : undefined}
      search={{ value: q, onChange: setQ, placeholder: "Filter by name…" }}
      actions={
        <>
          <TableActions ioType="floorplan" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/floorplans/new">Add floor plan</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        total={query.data?.count}
        columns={columns}
        flexColumn="description"
        tableId="floor-plan-stacks"
      />
      <FloorPlanStackDeleteDialog
        stack={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

/** Delete a floor plan and every floor of it. */
export function FloorPlanStackDeleteDialog({
  stack,
  onOpenChange,
  onDeleted,
}: {
  stack: FloorPlanStack | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/floor-plan-stacks/${stack!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${stack!.name}`)
      void qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
      void qc.invalidateQueries({ queryKey: ["floor-plans"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const floors = stack?.floor_count ?? 0
  return (
    <ConfirmDialog
      open={!!stack}
      onOpenChange={onOpenChange}
      title={`Delete ${stack?.name ?? ""}?`}
      description={`Removes this floor plan and its ${floors} floor${floors === 1 ? "" : "s"}, with everything drawn on them. Linked racks and devices are untouched.`}
      pending={m.isPending}
      onConfirm={() => m.mutate()}
    />
  )
}
