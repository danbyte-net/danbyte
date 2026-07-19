import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  PowerOutlet,
  PowerOutletWritePayload,
  PowerPort,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"

type FeedLeg = "" | "A" | "B" | "C"

const FEED_LEGS = [
  { value: "A", label: "A" },
  { value: "B", label: "B" },
  { value: "C", label: "C" },
]

export interface PowerOutletDialogProps {
  deviceId: string
  /** When set, the dialog edits this outlet instead of creating one. */
  outlet?: PowerOutlet | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Add/edit dialog for a device's power outlets (fed by one of its power ports).
export function PowerOutletDialog({
  deviceId,
  outlet,
  open,
  onOpenChange,
}: PowerOutletDialogProps) {
  const isEdit = !!outlet
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [powerPortId, setPowerPortId] = useState<string | null>(null)
  const [feedLeg, setFeedLeg] = useState<FeedLeg>("")
  const [description, setDescription] = useState("")

  // Fresh form every time the dialog opens (prefilled when editing).
  useEffect(() => {
    if (!open) return
    setName(outlet?.name ?? "")
    setType(outlet?.type ?? "")
    setPowerPortId(outlet?.power_port?.id ?? null)
    setFeedLeg(outlet?.feed_leg ?? "")
    setDescription(outlet?.description ?? "")
    reset()
  }, [open, outlet, reset])

  // An outlet is fed by a power port on the SAME device.
  const powerPorts = useQuery({
    queryKey: ["device-power-ports", deviceId],
    queryFn: () =>
      api<Paginated<PowerPort>>(`/api/power-ports/?device=${deviceId}`),
    enabled: open,
  })

  const mutation = useMutation({
    mutationFn: () => {
      const payload: PowerOutletWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        type,
        power_port_id: powerPortId,
        feed_leg: feedLeg,
        description: description.trim(),
      }
      if (isEdit)
        return api<PowerOutlet>(`/api/power-outlets/${outlet!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<PowerOutlet>("/api/power-outlets/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-power-outlets", deviceId] })
      // Power ports carry an outlet_count — keep it fresh.
      qc.invalidateQueries({ queryKey: ["device-power-ports", deviceId] })
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
            {isEdit ? "Edit power outlet" : "Add power outlet"}
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
            placeholder="Outlet1"
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
            options={choices.power_outlet_types ?? []}
            error={fieldErrors.type}
          />
          <div className="grid grid-cols-2 gap-3">
            <FormCombobox
              label="Fed by power port"
              value={powerPortId}
              onChange={setPowerPortId}
              noneLabel="None"
              placeholder="Pick a power port"
              searchPlaceholder="Search power ports…"
              emptyText="No power ports on this device."
              options={(powerPorts.data?.results ?? []).map((p) => ({
                value: p.id,
                label: p.name,
              }))}
              error={fieldErrors.power_port_id}
            />
            <FormSelect
              label="Feed leg"
              value={feedLeg || null}
              onChange={(v) => setFeedLeg((v ?? "") as FeedLeg)}
              noneLabel="None"
              placeholder="None"
              options={FEED_LEGS}
              error={fieldErrors.feed_leg}
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
            submitLabel={isEdit ? "Save changes" : "Create power outlet"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
