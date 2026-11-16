import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DeviceDependency } from "@/lib/api"
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
import { DEVICE_DEPENDENCY_KEYS } from "@/components/device-dependencies/dependency-dialog"

export function DeviceDependencyDeleteDialog({
  dependency,
  onOpenChange,
}: {
  dependency: DeviceDependency | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/device-dependencies/${dependency!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Deleted the dependency")
      for (const queryKey of DEVICE_DEPENDENCY_KEYS)
        qc.invalidateQueries({ queryKey })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  const d = dependency
  return (
    <AlertDialog open={!!d} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this dependency?</AlertDialogTitle>
          <AlertDialogDescription>
            {d
              ? `${d.downstream?.name ?? "Hidden"} ${
                  d.kind === "peer" ? "↔" : "depends on"
                } ${d.upstream?.name ?? "Hidden"}. The devices stay.`
              : ""}
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
