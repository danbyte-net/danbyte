import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LabelTemplate, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { LabelTemplateFormDialog } from "@/components/label-template-form"

export const Route = createFileRoute("/label-templates/")({
  component: LabelTemplatesPage,
})

function LabelTemplatesPage() {
  const { canDo } = useMe()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<LabelTemplate | null>(null)

  const query = useQuery({
    queryKey: ["label-templates"],
    queryFn: () =>
      api<Paginated<LabelTemplate>>("/api/label-templates/?page_size=500"),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const canManage = canDo("labeltemplate", "change")

  const columns = useMemo<ColumnDef<LabelTemplate>[]>(
    () => [
      {
        id: "name",
        accessorFn: (r) => r.name,
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) =>
          canManage ? (
            <button
              type="button"
              className="font-medium hover:underline"
              onClick={() => {
                setEditing(row.original)
                setFormOpen(true)
              }}
            >
              {row.original.name}
            </button>
          ) : (
            <span className="font-medium">{row.original.name}</span>
          ),
      },
      {
        id: "object_type",
        header: "Object type",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {row.original.object_type_label}
          </span>
        ),
      },
      {
        id: "size",
        header: "Size",
        cell: ({ row }) => (
          <span className="num text-muted-foreground">
            {row.original.width_mm}×{row.original.height_mm} mm
          </span>
        ),
      },
      {
        id: "qr",
        header: "QR",
        cell: ({ row }) =>
          row.original.qr_enabled ? (
            <Badge variant="secondary">On</Badge>
          ) : (
            <Badge variant="outline">Off</Badge>
          ),
      },
      {
        id: "default",
        header: "Default",
        cell: ({ row }) =>
          row.original.is_default ? (
            <Badge variant="secondary">Default</Badge>
          ) : null,
      },
      {
        id: "updated",
        header: "Updated",
        cell: ({ row }) => <TimeCell iso={row.original.updated_at} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canManage ? (
            <div className="flex justify-end gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  setEditing(row.original)
                  setFormOpen(true)
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <DeleteButton template={row.original} />
            </div>
          ) : null,
      },
    ],
    [canManage]
  )

  return (
    <ListPageShell
      title="Label templates"
      count={rows.length}
      actions={
        canDo("labeltemplate", "add") ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" /> New template
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No label templates yet.">
          Design a printable label (device asset tags, rack labels, …) with your
          own HTML and a QR code, then print it from any object's page.
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} tableId="label-templates" />
      )}
      <LabelTemplateFormDialog
        key={editing?.id ?? "new"}
        template={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
    </ListPageShell>
  )
}

function DeleteButton({ template }: { template: LabelTemplate }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/label-templates/${template.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Label template deleted")
      qc.invalidateQueries({ queryKey: ["label-templates"] })
      setOpen(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete “{template.name}”?</DialogTitle>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={m.isPending}
              onClick={() => m.mutate()}
            >
              {m.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
