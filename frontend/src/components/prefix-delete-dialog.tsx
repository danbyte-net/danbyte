import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Prefix } from "@/lib/api"
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

// Single-prefix delete confirm - used by the row's "..." menu. Bulk
// delete lives in prefix-bulk-bar.tsx (different shape, different action).

export interface PrefixDeleteDialogProps {
  prefix: Prefix | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

function impactText(d: {
  moved: number
  removed: number
  parent: string | null
}): string {
  const n = (c: number) => `${c} address${c === 1 ? "" : "es"}`
  if (!d.moved && !d.removed) return "No addresses are recorded inside it."
  const parts: string[] = []
  if (d.moved)
    parts.push(`${n(d.moved)} move to ${d.parent ?? "a containing prefix"}`)
  if (d.removed)
    parts.push(`${n(d.removed)} with no other container are removed`)
  return parts.join("; ") + "."
}

export function PrefixDeleteDialog({
  prefix,
  onOpenChange,
  onDeleted,
}: PrefixDeleteDialogProps) {
  const qc = useQueryClient()
  // What the delete does to the addresses on it, from the server's own
  // dry run - so the dialog says "3 move to 10.0.0.0/16" rather than a
  // sentence that has to cover every case.
  const impact = useQuery({
    queryKey: ["prefix-delete-impact", prefix?.id],
    queryFn: () =>
      api<{ moved: number; removed: number; parent: string | null }>(
        `/api/prefixes/${prefix!.id}/delete-impact/`
      ),
    enabled: !!prefix,
    staleTime: 0,
  })
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/prefixes/${prefix!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${prefix!.cidr}`)
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!prefix} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {prefix?.cidr}?</AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone.{" "}
            {impact.data
              ? impactText(impact.data)
              : "Addresses inside it move to the prefix that still contains them; any with no container are removed."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || impact.isLoading}
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
