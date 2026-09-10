import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { NATRule } from "@/lib/api"
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { NATRuleForm } from "@/components/nat-rule-form"
import { apiErrorToast } from "@/lib/api-toast"

// NAT rules have no `/nat-rules/$id/edit` route - this dialog *is* the editor,
// the same shape services use, so a rule is edited the same way from the list,
// its own page and a device's pane.

export function NATRuleFormDialog({
  rule,
  device,
  open,
  onOpenChange,
  onSaved,
}: {
  rule: NATRule | null
  /** Pre-set firewall when adding from a device's own pane. */
  device?: { id: string; name: string }
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: (saved: NATRule) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {rule ? `Edit ${rule.name}` : "Add NAT rule"}
          </DialogTitle>
        </DialogHeader>
        {open && (
          <NATRuleForm
            rule={rule}
            device={device}
            onSaved={onSaved}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

export function NATRuleDeleteDialog({
  rule,
  onOpenChange,
  onDeleted,
}: {
  rule: NATRule | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/nat-rules/${rule!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${rule!.name}`)
      qc.invalidateQueries({ queryKey: ["nat-rules-list"] })
      qc.invalidateQueries({ queryKey: ["nat-rules"] })
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
            This removes the record of the mapping. The firewall keeps doing
            whatever it is doing.
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
