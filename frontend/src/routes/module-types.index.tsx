import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type ModuleType, type Paginated } from "@/lib/api"
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
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { ManufacturerCell } from "@/components/cells/manufacturer-cell"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/module-types/")({
  component: ModuleTypesPage,
})

function ModuleTypesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ModuleType | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("moduletype", "add")
  const canEdit = canDo("moduletype", "change")
  const canDelete = canDo("moduletype", "delete")

  const query = useQuery({
    queryKey: ["module-types", q],
    queryFn: () =>
      api<Paginated<ModuleType>>(
        `/api/module-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((m: ModuleType) => setDeleting(m), [])
  const columns = useMemo<ColumnDef<ModuleType>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Module types"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, part number…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/module-types/new">Add module type</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      {rows.length === 0 ? (
        <p className="max-w-xl text-sm text-muted-foreground">
          No module types yet. Add one, or import them from the NetBox
          devicetype-library on the{" "}
          <Link to="/device-types" className="text-primary hover:underline">
            Device types
          </Link>{" "}
          page — module-type files are auto-detected.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="module-types"
        />
      )}
      <ModuleTypeDeleteDialog
        moduleType={deleting}
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
  onDelete: (m: ModuleType) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<ModuleType>[] {
  return [
    selectionColumn<ModuleType>(),
    ...(humanIds ? [numidColumn<ModuleType>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/module-types/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "manufacturer",
      accessorFn: (r) => r.manufacturer?.name ?? "",
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) => (
        <ManufacturerCell manufacturer={row.original.manufacturer} />
      ),
    },
    {
      id: "part_number",
      accessorKey: "part_number",
      header: "Part number",
      cell: ({ row }) =>
        row.original.part_number ? (
          <span className="font-mono text-xs">{row.original.part_number}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "interfaces",
      accessorKey: "interface_template_count",
      header: ({ column }) => <SortHeader column={column} label="Interfaces" />,
      cell: ({ row }) => (
        <span className="num text-xs">
          {row.original.interface_template_count}
        </span>
      ),
    },
    {
      id: "modules",
      accessorKey: "module_count",
      header: ({ column }) => <SortHeader column={column} label="Installed" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.module_count}</span>
      ),
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
    timeAgoColumn<ModuleType>({
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
          editTo={canEdit ? "/module-types/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}

export function ModuleTypeDeleteDialog({
  moduleType,
  onOpenChange,
  onDeleted,
}: {
  moduleType: ModuleType | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/module-types/${moduleType!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${moduleType!.name}`)
      qc.invalidateQueries({ queryKey: ["module-types"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const installed = moduleType?.module_count ?? 0
  return (
    <AlertDialog open={!!moduleType} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {moduleType?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {installed > 0
              ? `${installed} installed module${installed === 1 ? "" : "s"} reference this type — remove them first.`
              : "Removes this module type and its interface templates."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending || installed > 0}
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
