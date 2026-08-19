import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

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
import { NameRangeHint } from "@/components/name-range-hint"
import { createEach, expandNameRange } from "@/lib/name-range"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { usePlanTarget, useSaveObject } from "@/lib/save-object"

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
  const saveObject = useSaveObject()
  const isPlanning = !!usePlanTarget()

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
        return saveObject<PowerPort>({
          objectType: "api.powerport",
          endpoint: "/api/power-ports/",
          id: port!.id,
          payload,
        }).then((saved) => ({ saved, count: 1 }))
      // A [a-b] range in the name fans out - "PSU[1-2]" adds both inlets. In
      // plan mode saveObject stages one create per expanded name, so a planned
      // range records both inlets rather than one.
      const names = expandNameRange(payload.name)
      if (names.length > 1 && isPlanning)
        return saveObject<PowerPort>({
          objectType: "api.powerport",
          endpoint: "/api/power-ports/",
          payload,
          names,
        }).then((saved) => ({ saved, count: names.length }))
      return createEach(names, (n) =>
        saveObject<PowerPort>({
          objectType: "api.powerport",
          endpoint: "/api/power-ports/",
          payload: { ...payload, name: n },
        })
      ).then(({ last, count }) => ({ saved: last, count }))
    },
    onSuccess: ({ saved, count }) => {
      qc.invalidateQueries({ queryKey: ["device-power-ports", deviceId] })
      // Outlets label their feed with the port name - keep them fresh.
      qc.invalidateQueries({ queryKey: ["device-power-outlets", deviceId] })
      toast.success(
        isEdit
          ? `Updated ${saved.name}`
          : count > 1
            ? `Created ${count} power ports`
            : `Created ${saved.name}`
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
      <DialogContent size="lg">
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
            hint={isEdit ? undefined : "a [1-2] range adds one port per number"}
            error={fieldErrors.name}
          />
          <NameRangeHint name={name} editing={isEdit} noun="power ports" />
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
