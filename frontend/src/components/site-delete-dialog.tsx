import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Site } from "@/lib/api"
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

export interface SiteDeleteDialogProps {
  site: Site | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function SiteDeleteDialog({
  site,
  onOpenChange,
  onDeleted,
}: SiteDeleteDialogProps) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/sites/${site!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${site!.name}`)
      qc.invalidateQueries({ queryKey: ["sites"] })
      qc.invalidateQueries({ queryKey: ["sites-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  const inUse = !!site && site.prefix_count + site.vlan_count > 0
  return (
    <AlertDialog open={!!site} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete site {site?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `Still referenced by ${site?.prefix_count} prefix${site?.prefix_count === 1 ? "" : "es"} and ${site?.vlan_count} VLAN${site?.vlan_count === 1 ? "" : "s"}. Those rows will keep their data but lose the site link.`
              : "This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
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
