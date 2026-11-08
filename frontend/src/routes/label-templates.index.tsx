import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { LabelTemplate, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { buildLabelTemplateColumns } from "@/components/columns/label-template-columns"
import { LabelTemplateFormDialog } from "@/components/label-template-form"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"

export const Route = createFileRoute("/label-templates/")({
  component: LabelTemplatesPage,
})

function LabelTemplatesPage() {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<LabelTemplate | null>(null)
  const [deleting, setDeleting] = useState<LabelTemplate | null>(null)
  const [selected, setSelected] = useState<LabelTemplate[]>([])

  const query = useQuery({
    queryKey: ["label-templates"],
    queryFn: () =>
      api<Paginated<LabelTemplate>>("/api/label-templates/?page_size=500"),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const canManage = canDo("labeltemplate", "change")
  const canDelete = canDo("labeltemplate", "delete")
  const selectable = canManage || canDelete

  const remove = useMutation({
    mutationFn: (t: LabelTemplate) =>
      api<void>(`/api/label-templates/${t.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Label template deleted")
      void qc.invalidateQueries({ queryKey: ["label-templates"] })
      setDeleting(null)
    },
    onError: (e) => apiErrorToast(e),
  })

  const open = useCallback((t: LabelTemplate) => {
    setEditing(t)
    setFormOpen(true)
  }, [])
  const columns = useMemo(
    () =>
      buildLabelTemplateColumns({
        selection: selectable,
        onOpen: canManage ? open : undefined,
        actions: {
          onEdit: open,
          canEdit: () => canManage,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [canManage, canDelete, selectable, open]
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
        <DataTable
          data={rows}
          columns={columns}
          tableId="label-templates"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/label-templates/"
        noun={["template", "templates"]}
        invalidate={[["label-templates"]]}
        onCleared={() => setSelected([])}
        canEdit={canManage}
        canDelete={canDelete}
        ioType="labeltemplate"
      />
      <LabelTemplateFormDialog
        key={editing?.id ?? "new"}
        template={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete “${deleting?.name ?? ""}”?`}
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </ListPageShell>
  )
}
