import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorTileType, Paginated } from "@/lib/api"
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
import { ListPageShell } from "@/components/list-page-shell"
import { DynamicIcon } from "@/components/dynamic-icon"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/floor-tile-types/")({
  component: FloorTileTypesPage,
})

function FloorTileTypesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("floortiletype", "add")
  const canEdit = canDo("floortiletype", "change")
  const canDelete = canDo("floortiletype", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<FloorTileType | null>(null)

  const query = useQuery({
    queryKey: ["floor-tile-types", q],
    queryFn: () =>
      api<Paginated<FloorTileType>>(
        `/api/floor-tile-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((t: FloorTileType) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<FloorTileType>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Floor tiles"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/floor-tile-types/new">Add tile type</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      {rows.length === 0 && !q ? (
        <p className="text-sm text-muted-foreground">
          No tile types yet. The floor-plan palette is yours to define — create
          “Rack”, “Wall”, “Cooling”, “Camera”… whatever your rooms contain.
          Device roles appear in the palette automatically.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="floor-tile-types"
        />
      )}
      <FloorTileTypeDeleteDialog
        tileType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (t: FloorTileType) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<FloorTileType>[] {
  return [
    selectionColumn<FloorTileType>(),
    ...(humanIds ? [numidColumn<FloorTileType>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-2">
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border"
            style={
              row.original.color
                ? { backgroundColor: `${row.original.color}33` }
                : undefined
            }
          >
            <DynamicIcon name={row.original.icon} className="h-3.5 w-3.5" />
          </span>
          <span className="font-medium">{row.original.name}</span>
        </span>
      ),
    },
    {
      id: "color",
      accessorKey: "color",
      header: "Color",
      cell: ({ row }) =>
        row.original.color ? (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="h-3 w-3 rounded-sm border border-border"
              style={{ backgroundColor: row.original.color }}
            />
            <span className="font-mono text-xs">{row.original.color}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "size",
      header: "Default size",
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.default_width} × {row.original.default_height}
        </span>
      ),
    },
    {
      id: "tiles",
      accessorFn: (r) => r.tile_count,
      header: ({ column }) => <SortHeader column={column} label="Placed" />,
      cell: ({ row }) =>
        row.original.tile_count > 0 ? (
          <span className="num text-xs">
            {row.original.tile_count} tile
            {row.original.tile_count === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="text-muted-foreground">unused</span>
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
    timeAgoColumn<FloorTileType>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/floor-tile-types/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

export function FloorTileTypeDeleteDialog({
  tileType,
  onOpenChange,
  onDeleted,
}: {
  tileType: FloorTileType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/floor-tile-types/${tileType!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${tileType!.name}`)
      qc.invalidateQueries({ queryKey: ["floor-tile-types"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const placed = tileType?.tile_count ?? 0
  return (
    <AlertDialog open={!!tileType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {tileType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {placed > 0
              ? `${placed} placed tile${placed === 1 ? "" : "s"} use this type — remove them from their floor plans first.`
              : "Removes this tile type from the palette."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending || placed > 0}
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
