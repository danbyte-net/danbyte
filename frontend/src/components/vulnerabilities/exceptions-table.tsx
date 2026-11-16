import { useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { VulnException } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { selectionColumn } from "@/components/data-table"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { actionsColumn } from "@/components/columns/actions-column"
import { buildVulnerabilityExceptionColumns } from "@/components/columns/vulnerability-exception-columns"
import type { VulnExceptionColumnId } from "@/components/columns/vulnerability-exception-columns"
import {
  EXCEPTIONS_ENDPOINT,
  ExceptionDialog,
  invalidateExceptions,
  useExceptionPerms,
} from "@/components/vulnerabilities/exception-dialog"

// What every exceptions table shares (#451): the columns with a selection
// box and the row's Edit and Delete (as the role allows), the edit dialog,
// the delete confirmation and the bulk-delete bar.

export function useExceptionTable(opts: { omit?: VulnExceptionColumnId[] }) {
  const { today } = useDateFormat()
  const { canChange, canDelete } = useExceptionPerms()
  const [editing, setEditing] = useState<VulnException | null>(null)
  const [deleting, setDeleting] = useState<VulnException | null>(null)
  const [selected, setSelected] = useState<VulnException[]>([])
  const omitKey = (opts.omit ?? []).join(",")
  const columns = useMemo(
    () => [
      ...(canDelete ? [selectionColumn<VulnException>()] : []),
      ...buildVulnerabilityExceptionColumns({
        omit: omitKey ? (omitKey.split(",") as VulnExceptionColumnId[]) : [],
        today,
      }),
      ...(canChange || canDelete
        ? [
            actionsColumn<VulnException>({
              onEdit: canChange ? setEditing : undefined,
              onDelete: canDelete ? setDeleting : undefined,
            }),
          ]
        : []),
    ],
    [canChange, canDelete, omitKey, today]
  )
  const overlays = (
    <>
      <ExceptionDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        exception={editing}
      />
      <DeleteExceptionDialog
        exception={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SafeBulkDeleteBar
        selected={selected}
        endpoint={EXCEPTIONS_ENDPOINT}
        noun={["exception", "exceptions"]}
        invalidate={[
          ["vulnerability-exceptions"],
          ["vulnerabilities"],
          ["vulnerability"],
          ["vulnerability-matches"],
        ]}
        onCleared={() => setSelected([])}
        canDelete={canDelete}
      />
    </>
  )
  return { columns, selected, setSelected, overlays }
}

export function DeleteExceptionDialog({
  exception,
  onOpenChange,
  onDeleted,
}: {
  exception: VulnException | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: (id: string) =>
      api(`${EXCEPTIONS_ENDPOINT}${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateExceptions(qc)
      toast.success("Exception deleted")
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <ConfirmDialog
      open={!!exception}
      onOpenChange={onOpenChange}
      title="Delete exception?"
      description={
        exception
          ? `${exception.cve.vuln_id}: its ${exception.matches.toLocaleString()} covered matches open again.`
          : undefined
      }
      confirmLabel="Delete"
      pendingLabel="Deleting…"
      destructive
      pending={del.isPending}
      onConfirm={() => exception && del.mutate(exception.id)}
    />
  )
}
