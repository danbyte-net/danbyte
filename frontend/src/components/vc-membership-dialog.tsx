import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Device, type VirtualChassisMember } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormFooter, FormText, useFieldErrors } from "@/components/forms"

export interface VcMembershipDialogProps {
  /** The chassis whose member list should refresh after saving. */
  chassisId: string
  /** The member device whose position/priority is being edited. */
  member: VirtualChassisMember | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Edits a member device's vc_position / vc_priority in place — membership is
// owned by the Device (PATCH /api/devices/:id/), so this is a device write.
export function VcMembershipDialog({
  chassisId,
  member,
  open,
  onOpenChange,
}: VcMembershipDialogProps) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [position, setPosition] = useState("")
  const [priority, setPriority] = useState("")

  // Fresh form every time the dialog opens.
  useEffect(() => {
    if (!open || !member) return
    setPosition(member.vc_position != null ? String(member.vc_position) : "")
    setPriority(member.vc_priority != null ? String(member.vc_priority) : "")
    reset()
  }, [open, member, reset])

  const mutation = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${member!.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          vc_position: position.trim() === "" ? null : Number(position),
          vc_priority: priority.trim() === "" ? null : Number(priority),
        }),
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["virtual-chassis", chassisId] })
      qc.invalidateQueries({ queryKey: ["virtual-chassis"] })
      qc.invalidateQueries({ queryKey: ["devices"] })
      qc.invalidateQueries({ queryKey: ["device", saved.id] })
      qc.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("interface"),
      })
      const renamed = (saved as { vc_renamed_interfaces?: number | null })
        .vc_renamed_interfaces
      toast.success(
        `Updated ${saved.name}` +
          (renamed ? ` — ${renamed} interfaces renamed to match` : "")
      )
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit membership — {member?.name}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Position"
              type="number"
              autoFocus
              value={position}
              onChange={setPosition}
              placeholder="1"
              error={fieldErrors.vc_position}
            />
            <FormText
              label="Priority"
              type="number"
              value={priority}
              onChange={setPriority}
              placeholder="128"
              error={fieldErrors.vc_priority}
            />
          </div>
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel="Save changes"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
