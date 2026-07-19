import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Tenant } from "@/lib/api"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { apiErrorToast } from "@/lib/api-toast"

export interface TenantDeleteDialogProps {
  tenant: Tenant | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

// Tenant deletes are catastrophic — every prefix/IP/VLAN under them
// cascades. Require the user to type the tenant name to confirm, like
// GitHub does for repo deletion.
export function TenantDeleteDialog({
  tenant,
  onOpenChange,
  onDeleted,
}: TenantDeleteDialogProps) {
  const qc = useQueryClient()
  const [typed, setTyped] = useState("")

  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/tenants/${tenant!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${tenant!.name}`)
      qc.invalidateQueries({ queryKey: ["tenants"] })
      qc.invalidateQueries({ queryKey: ["tenants-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const matches = typed === tenant?.name
  const total =
    (tenant?.site_count ?? 0) +
    (tenant?.prefix_count ?? 0) +
    (tenant?.vlan_count ?? 0) +
    (tenant?.ip_count ?? 0)

  return (
    <AlertDialog
      open={!!tenant}
      onOpenChange={(o) => {
        if (!o) setTyped("")
        onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete tenant {tenant?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {total > 0
              ? `This will permanently delete ${tenant?.site_count} site${tenant?.site_count === 1 ? "" : "s"}, ${tenant?.prefix_count} prefix${tenant?.prefix_count === 1 ? "" : "es"}, ${tenant?.vlan_count} VLAN${tenant?.vlan_count === 1 ? "" : "s"}, ${tenant?.ip_count} IP${tenant?.ip_count === 1 ? "" : "s"}, and every other record owned by this tenant.`
              : "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-1.5">
          <Label className="text-xs">
            Type <span className="font-mono font-semibold">{tenant?.name}</span>{" "}
            to confirm
          </Label>
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={tenant?.name}
            autoComplete="off"
            autoFocus
          />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending || !matches}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete tenant"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
