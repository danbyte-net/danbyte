import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { EolCustomProduct } from "@/lib/api"
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

/** Delete a custom end-of-life product. Refused while an application or a
 * platform names it - the server says so too. */
export function EolProductDeleteDialog({
  product,
  onOpenChange,
  onDeleted,
}: {
  product: EolCustomProduct | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/eol/custom-products/${product!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${product!.label}`)
      qc.invalidateQueries({ queryKey: ["eol-custom-products"] })
      qc.invalidateQueries({ queryKey: ["eol-products"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })
  const apps = product?.application_count ?? 0
  const platforms = product?.platform_count ?? 0
  const inUse = apps + platforms > 0
  const users = [
    apps ? plural(apps, "application") : "",
    platforms ? plural(platforms, "platform") : "",
  ]
    .filter(Boolean)
    .join(" and ")
  return (
    <AlertDialog open={!!product} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {product?.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            {inUse
              ? `In use by ${users} - map them to another product first.`
              : "Its cycles go with it. This action can't be undone."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || inUse}
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
