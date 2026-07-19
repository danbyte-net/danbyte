import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Interface,
  type MacObjectDetail,
  type MACAddress,
  type MACAddressWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  FormSelect,
  FormTags,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

/**
 * Create or edit a first-class MAC address object — its address, the interface
 * it's assigned to (optional), a description, tags and custom fields. This is
 * the write path for the `/api/mac-addresses/` CRUD endpoint; the `/macs`
 * aggregation reflects the result once saved.
 */
export function MacObjectDialog({
  open,
  onOpenChange,
  object,
  presetMac,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Edit an existing object; omit to create a new one. */
  object?: MacObjectDetail | null
  /** Pre-fill the MAC when creating (e.g. from a MAC's detail page). */
  presetMac?: string
}) {
  const qc = useQueryClient()
  const isEdit = !!object
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [mac, setMac] = useState("")
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [interfaceId, setInterfaceId] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  const [tagIds, setTagIds] = useState<number[]>([])
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({})

  // Seed the form whenever the dialog opens (edit → object's values; create →
  // the preset MAC, everything else blank).
  useEffect(() => {
    if (!open) return
    if (object) {
      setMac(object.mac_address)
      setDeviceId(object.assigned_interface?.device.id ?? null)
      setInterfaceId(object.assigned_interface?.id ?? null)
      setDescription(object.description)
      setTagIds(object.tags.map((t) => t.id))
      setCustomFields(object.custom_fields ?? {})
    } else {
      setMac(presetMac ?? "")
      setDeviceId(null)
      setInterfaceId(null)
      setDescription("")
      setTagIds([])
      setCustomFields({})
    }
    reset()
  }, [open, object, presetMac, reset])

  const interfaces = useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<Interface>>(
        `/api/interfaces/?device=${deviceId}&page_size=500`
      ),
    enabled: !!deviceId,
  })

  const canSubmit = mac.trim().length > 0

  const m = useMutation({
    mutationFn: () => {
      const payload: MACAddressWritePayload = {
        mac_address: mac.trim(),
        assigned_interface_id: interfaceId,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<MACAddress>(`/api/mac-addresses/${object!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<MACAddress>("/api/mac-addresses/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["macs"] })
      qc.invalidateQueries({ queryKey: ["mac"] })
      // Both the interfaces list ("interfaces") and an interface's detail page
      // ("interface", id) render this MAC on its assigned interface.
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["interface"] })
      toast.success(
        isEdit ? `Updated ${saved.mac_address}` : `Created ${saved.mac_address}`
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
          <DialogTitle>
            {isEdit ? "Edit MAC object" : "Add MAC object"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) m.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="MAC address"
            required
            autoFocus={!isEdit}
            value={mac}
            onChange={setMac}
            mono
            placeholder="00:1b:44:11:3a:b7"
            error={fieldErrors.mac_address}
          />
          <div className="grid grid-cols-2 gap-3">
            <DevicePicker
              value={deviceId}
              onChange={(v) => {
                setDeviceId(v)
                setInterfaceId(null)
              }}
              noneLabel="No device"
              placeholder="No device"
            />
            <FormSelect
              label="Assigned interface"
              value={interfaceId}
              onChange={setInterfaceId}
              noneLabel="— none —"
              placeholder={deviceId ? "Pick interface" : "Pick device first"}
              options={(interfaces.data?.results ?? []).map((i) => ({
                value: i.id,
                label: i.name,
              }))}
            />
          </div>
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="e.g. NIC1 — replaced 2026-06"
            error={fieldErrors.description}
          />
          <FormTags label="Tags" value={tagIds} onChange={setTagIds} />
          <CustomFieldInputs
            model="macaddress"
            value={customFields}
            onChange={setCustomFields}
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={m.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || m.isPending}>
              {m.isPending
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Add MAC object"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
