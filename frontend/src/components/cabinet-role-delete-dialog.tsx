import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ApiError, api, apiErrorMessage } from "@/lib/api"
import type { CabinetRole } from "@/lib/api"
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
import { apiErrorToast } from "@/lib/api-toast"

export interface CabinetRoleDeleteDialogProps {
  role: CabinetRole | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

/** A role in use can't be deleted: the server answers 409 with how many
 * cabinets use it. The dialog says so up front from the role's count, and
 * shows the server's answer when cabinets took the role after it loaded. */
export function CabinetRoleDeleteDialog({
  role,
  onOpenChange,
  onDeleted,
}: CabinetRoleDeleteDialogProps) {
  const qc = useQueryClient()
  // Kept per role, so the dialog opened on another one starts clean.
  const [refused, setRefused] = useState<{ id: string; detail: string }>()
  const m = useMutation({
    mutationFn: (target: CabinetRole) =>
      api<void>(`/api/cabinet-roles/${target.id}/`, { method: "DELETE" }),
    onSuccess: (_, target) => {
      toast.success(`Deleted ${target.name}`)
      qc.invalidateQueries({ queryKey: ["cabinet-roles"] })
      qc.invalidateQueries({ queryKey: ["cabinet-roles-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err, target) => {
      if (err instanceof ApiError && err.status === 409) {
        setRefused({ id: target.id, detail: apiErrorMessage(err) })
        qc.invalidateQueries({ queryKey: ["cabinet-roles"] })
        qc.invalidateQueries({ queryKey: ["cabinet-role", target.id] })
        return
      }
      apiErrorToast(err)
    },
  })

  const used = role?.cabinet_count ?? 0
  const inUse =
    role && refused?.id === role.id
      ? refused.detail
      : used > 0
        ? `${used} cabinet${used === 1 ? " uses" : "s use"} this role - unassign them first.`
        : null

  return (
    <AlertDialog open={!!role} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete role {role?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse ?? "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || !!inUse}
            onClick={(e) => {
              e.preventDefault()
              if (role) m.mutate(role)
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
