import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { InventoryProfile } from "@/lib/api"
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

// Deleting a discovery profile (#451): its runs and their per-host results
// cascade; what the runs found (packages, open ports) stays on the hosts.

/** What goes with a profile, and what stays. */
export function profileDeleteText(kind: InventoryProfile["kind"]): string {
  return kind === "service_scan"
    ? "Its runs go with it. Open ports found stay."
    : "Its runs go with it. Packages read stay on their hosts."
}

export function ProfileDeleteDialog({
  profile,
  onOpenChange,
  onDeleted,
}: {
  profile: InventoryProfile | null
  onOpenChange: (o: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (p: InventoryProfile) =>
      api<void>(`/api/discovery/profiles/${p.id}/`, { method: "DELETE" }),
    onSuccess: (_, p) => {
      toast.success(`Deleted ${p.name}`)
      qc.invalidateQueries({ queryKey: ["discovery", "profiles"] })
      qc.invalidateQueries({ queryKey: ["discovery", "runs"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog
      open={!!profile}
      onOpenChange={(o) => !m.isPending && onOpenChange(o)}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {profile ? profileDeleteText(profile.kind) : null}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              if (profile) m.mutate(profile)
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
