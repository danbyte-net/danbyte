import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Search } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
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
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4 lg:px-6">
        <h1 className="text-base font-semibold">Floor plans</h1>
        {query.data && <Badge variant="secondary">{rows.length}</Badge>}
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter by name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="h-8 w-72 pl-8 text-xs"
            />
          </div>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/floorplans/new">Add floor plan</Link>
            </Button>
          )}
        </div>
      </header>

      <div className="flex-1 overflow-auto p-4 lg:p-6">
        {query.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {query.isError && <QueryError error={query.error} />}
        {query.data && rows.length === 0 && !q && (
          <p className="text-sm text-muted-foreground">
            No floor plans yet. A floor plan lays out a location — a room, a
            hall, a floor — as a grid of tiles linked to your racks and devices.
            Define your tile palette under Customize → Floor tiles, then add a
            plan here.
          </p>
        )}
        {query.data && (rows.length > 0 || !!q) && (
          <DataTable
            data={rows}
            columns={columns}
            flexColumn="description"
            tableId="floor-plans"
          />
        )}
      </div>

      <FloorPlanDeleteDialog
        plan={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
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
    {
      id: "location",
      accessorFn: (r) => r.location.name,
      header: ({ column }) => <SortHeader column={column} label="Location" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.location.name}
        </span>
      ),
    },
    {
      id: "site",
      accessorFn: (r) => r.site.name,
      header: ({ column }) => <SortHeader column={column} label="Site" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.site.name}</span>
      ),
    },
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
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
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
