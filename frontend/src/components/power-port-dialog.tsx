import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { PowerPort, PowerPortWritePayload } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export interface PowerPortDialogProps {
  deviceId: string
  /** When set, the dialog edits this port instead of creating one. */
  port?: PowerPort | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Add/edit dialog for a device's power ports (inlets drawing from a feed).
export function PowerPortDialog({
  deviceId,
  port,
  open,
  onOpenChange,
}: PowerPortDialogProps) {
  const isEdit = !!port
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [maximumDraw, setMaximumDraw] = useState("")
  const [allocatedDraw, setAllocatedDraw] = useState("")
  const [description, setDescription] = useState("")

  // Fresh form every time the dialog opens (prefilled when editing).
  useEffect(() => {
    if (!open) return
    setName(port?.name ?? "")
    setType(port?.type ?? "")
    setMaximumDraw(port?.maximum_draw != null ? String(port.maximum_draw) : "")
    setAllocatedDraw(
      port?.allocated_draw != null ? String(port.allocated_draw) : ""
    )
    setDescription(port?.description ?? "")
    reset()
  }, [open, port, reset])

  const mutation = useMutation({
    mutationFn: () => {
      const payload: PowerPortWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        type,
        maximum_draw: maximumDraw.trim() === "" ? null : Number(maximumDraw),
        allocated_draw:
          allocatedDraw.trim() === "" ? null : Number(allocatedDraw),
        description: description.trim(),
      }
      if (isEdit)
        return api<PowerPort>(`/api/power-ports/${port!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<PowerPort>("/api/power-ports/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-power-ports", deviceId] })
      // Outlets label their feed with the port name — keep them fresh.
      qc.invalidateQueries({ queryKey: ["device-power-outlets", deviceId] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
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
          <DialogTitle>
            {isEdit ? "Edit power port" : "Add power port"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            mono
            placeholder="PSU1"
            error={fieldErrors.name}
          />
          <FormCombobox
            label="Type"
            value={type || null}
            onChange={(v) => setType(v ?? "")}
            noneLabel="No type"
            placeholder="Pick a type"
            searchPlaceholder="Search types…"
            emptyText="No types."
            options={choices.power_port_types ?? []}
            error={fieldErrors.type}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Maximum draw (W)"
              type="number"
              value={maximumDraw}
              onChange={setMaximumDraw}
              placeholder="750"
              error={fieldErrors.maximum_draw}
            />
            <FormText
              label="Allocated draw (W)"
              type="number"
              value={allocatedDraw}
              onChange={setAllocatedDraw}
              placeholder="400"
              error={fieldErrors.allocated_draw}
            />
          </div>
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Optional"
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Create power port"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
