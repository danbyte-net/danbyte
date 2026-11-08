import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ComplianceRule } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
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

import { invalidateCompliance } from "./compliance-shared"

export function DeleteRule({
  rule,
  onOpenChange,
  onDeleted,
}: {
  rule: ComplianceRule | null
  onOpenChange: (o: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/compliance-rules/${rule!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rule!.name}`)
      qc.invalidateQueries({ queryKey: ["compliance-rules"] })
      invalidateCompliance(qc)
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!rule} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {rule?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            This rule will no longer be evaluated.
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
