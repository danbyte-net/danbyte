import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlan, Paginated } from "@/lib/api"
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
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { locationColumn } from "@/components/cells/location-cell"
import { siteColumn } from "@/components/cells/site-cell"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/floorplans/")({
  component: FloorPlansPage,
})

function FloorPlansPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("floorplan", "add")
  const canDelete = canDo("floorplan", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<FloorPlan | null>(null)

  const query = useQuery({
    queryKey: ["floor-plans", q],
    queryFn: () =>
      api<Paginated<FloorPlan>>(
        `/api/floor-plans/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((p: FloorPlan) => setDeleting(p), [])
  const columns = useMemo<ColumnDef<FloorPlan>[]>(
    () => buildColumns({ onDelete: handleDelete, canDelete, humanIds }),
    [handleDelete, canDelete, humanIds]
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
        columns={columns}
        flexColumn="description"
        tableId="floor-plans"
      />
      <FloorPlanDeleteDialog
        plan={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canDelete,
  humanIds,
}: {
  onDelete: (p: FloorPlan) => void
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<FloorPlan>[] {
  return [
    selectionColumn<FloorPlan>(),
    ...(humanIds ? [numidColumn<FloorPlan>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/floorplans/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    locationColumn<FloorPlan>({ get: (r) => r.location }),
    siteColumn<FloorPlan>({ get: (r) => r.site }),
    {
      id: "grid",
      header: "Grid",
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.grid_width} × {row.original.grid_height}
        </span>
      ),
    },
    {
      id: "tiles",
      accessorFn: (r) => r.tile_count,
      header: ({ column }) => <SortHeader column={column} label="Tiles" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.tile_count}</span>
      ),
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.description || ""}
        </span>
      ),
    },
    timeAgoColumn<FloorPlan>({
      id: "updated",
      header: "Last edited",
      get: (r) => r.updated_at,
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

export function FloorPlanDeleteDialog({
  plan,
  onOpenChange,
  onDeleted,
}: {
  plan: FloorPlan | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/floor-plans/${plan!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${plan!.name}`)
      qc.invalidateQueries({ queryKey: ["floor-plans"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const tiles = plan?.tile_count ?? 0
  return (
    <AlertDialog open={!!plan} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {plan?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes this floor plan
            {tiles > 0
              ? ` and its ${tiles} placed tile${tiles === 1 ? "" : "s"}`
              : ""}
            . Linked racks and devices are untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
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
