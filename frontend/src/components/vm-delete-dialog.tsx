import { useCallback, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { PrtgDeleteResult, VirtualMachine } from "@/lib/api"
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
import {
  KEEP_IN_PRTG,
  PrtgDeleteOption,
  prtgDeleteQuery,
  prtgDeleteToast,
} from "@/components/prtg/delete-option"
import type { PrtgDeleteChoice } from "@/components/prtg/delete-option"

export interface VmDeleteDialogProps {
  vm: VirtualMachine | null
  onOpenChange: (open: boolean) => void
  onDeleted?: () => void
}

export function VmDeleteDialog({
  vm,
  onOpenChange,
  onDeleted,
}: VmDeleteDialogProps) {
  const qc = useQueryClient()
  const [prtg, setPrtg] = useState<PrtgDeleteChoice>(KEEP_IN_PRTG)
  const [prtgReady, setPrtgReady] = useState(true)
  const onPrtg = useCallback((c: PrtgDeleteChoice, ready: boolean) => {
    setPrtg(c)
    setPrtgReady(ready)
  }, [])
  const m = useMutation({
    mutationFn: () =>
      api<{ prtg?: PrtgDeleteResult[] } | undefined>(
        `/api/virtual-machines/${vm!.id}/${prtgDeleteQuery(prtg)}`,
        { method: "DELETE" }
      ),
    onSuccess: (res) => {
      toast.success(`Deleted ${vm!.name}`)
      prtgDeleteToast(res?.prtg)
      qc.invalidateQueries({ queryKey: ["prtg-links"] })
      qc.invalidateQueries({ queryKey: ["virtual-machines"] })
      qc.invalidateQueries({ queryKey: ["virtual-machines-picker"] })
      onOpenChange(false)
      onDeleted?.()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!vm} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete virtual machine {vm?.name}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <PrtgDeleteOption
          key={vm?.id}
          parent={vm ? { virtual_machine: vm.id } : null}
          onChange={onPrtg}
        />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending || !prtgReady}
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
