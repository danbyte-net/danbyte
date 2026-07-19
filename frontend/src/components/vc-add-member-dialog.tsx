import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Device } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormFooter, FormText, useFieldErrors } from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"

export interface VcAddMemberDialogProps {
  /** The chassis the picked device joins. */
  chassisId: string
  /** Member device ids already in the stack — hidden from the picker. */
  memberIds: string[]
  /** Suggested position for the new member (next free slot). */
  suggestedPosition?: number
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Adds a device to the stack from the chassis side: pick any device by
// search, give it a position/priority, and PATCH the device (membership is
// owned by the Device row, same as the device edit form's Stack membership).
export function VcAddMemberDialog({
  chassisId,
  memberIds,
  suggestedPosition,
  open,
  onOpenChange,
}: VcAddMemberDialogProps) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [position, setPosition] = useState("")
  const [priority, setPriority] = useState("")

  // Fresh form every time the dialog opens, with the next free position
  // pre-filled so stacking members is one pick + Enter.
  useEffect(() => {
    if (!open) return
    setDeviceId(null)
    setPosition(suggestedPosition != null ? String(suggestedPosition) : "")
    setPriority("")
    reset()
  }, [open, suggestedPosition, reset])

  const mutation = useMutation({
    mutationFn: () =>
      api<Device>(`/api/devices/${deviceId}/`, {
        method: "PATCH",
        body: JSON.stringify({
          virtual_chassis_id: chassisId,
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
        `${saved.name} added to stack` +
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
          <DialogTitle>Add member</DialogTitle>
          <DialogDescription>
            Search for a device and give it a slot in this stack. Devices
            already in a stack are greyed out — reassign those from the device's
            own edit form.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (deviceId) mutation.mutate()
          }}
          className="grid gap-4"
        >
          <DevicePicker
            value={deviceId}
            onChange={setDeviceId}
            excludeIds={memberIds}
            ghostAssignedVc
            error={fieldErrors.virtual_chassis_id}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Position"
              type="number"
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
            submitLabel="Add to stack"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
