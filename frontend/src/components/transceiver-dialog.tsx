import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  TRANSCEIVER_CONNECTOR_OPTIONS,
  TRANSCEIVER_STANDARDS,
} from "@/lib/api"
import type {
  Interface,
  InterfaceTransceiver,
  InventoryItemRow,
  TransceiverConnector,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormFooter,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { ObjectPicker } from "@/components/object-picker"
import type { ObjectPickerSpec } from "@/components/object-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"

/**
 * Transceivers per port (docs/dcim/inventory.md → Transceivers): an
 * inventory item of kind transceiver linked to the interface it sits in.
 * The interface's Overview shows it and sets or removes it here; the
 * device's inventory form edits the same fields.
 */

/** "SFP-10G-SR · FNS1234 · 10GBASE-SR" - what the port holds, in words. */
export function transceiverText(
  t: Pick<
    InterfaceTransceiver,
    "name" | "part_id" | "serial_number" | "standard"
  >
): string {
  return (
    [t.part_id, t.serial_number, t.standard].filter(Boolean).join(" · ") ||
    t.name
  )
}

/** The transceiver's own facts, as the inventory form and the new-transceiver
 * form edit them. */
export interface TransceiverFacts {
  standard: string
  connector: TransceiverConnector | ""
  wavelength: string
  reach: string
}

export const NO_FACTS: TransceiverFacts = {
  standard: "",
  connector: "",
  wavelength: "",
  reach: "",
}

export function factsOf(
  item: Pick<
    InventoryItemRow,
    "standard" | "connector" | "wavelength_nm" | "reach_m"
  > | null
): TransceiverFacts {
  if (!item) return NO_FACTS
  return {
    standard: item.standard,
    connector: item.connector,
    wavelength: item.wavelength_nm != null ? String(item.wavelength_nm) : "",
    reach: item.reach_m != null ? String(item.reach_m) : "",
  }
}

/** The facts as the API takes them. */
export function factsPayload(f: TransceiverFacts) {
  const int = (v: string) => (v.trim() ? Number(v) : null)
  return {
    standard: f.standard.trim(),
    connector: f.connector,
    wavelength_nm: int(f.wavelength),
    reach_m: int(f.reach),
  }
}

const CONNECTOR_OPTIONS = [
  { value: "", label: "-" },
  ...TRANSCEIVER_CONNECTOR_OPTIONS,
]

/** Standard, connector, wavelength and reach. */
export function TransceiverFactFields({
  value,
  onChange,
  errors,
}: {
  value: TransceiverFacts
  onChange: (v: TransceiverFacts) => void
  errors: Record<string, string | undefined>
}) {
  const set = (k: keyof TransceiverFacts) => (v: string) =>
    onChange({ ...value, [k]: v })
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <FormText
        label="Standard"
        value={value.standard}
        onChange={set("standard")}
        placeholder="10GBASE-SR"
        suggestions={TRANSCEIVER_STANDARDS}
        mono
        error={errors.standard}
      />
      <FormSelect
        label="Connector"
        value={value.connector}
        onChange={(v) => set("connector")(v ?? "")}
        options={CONNECTOR_OPTIONS}
        error={errors.connector}
      />
      <FormText
        label="Wavelength (nm)"
        type="number"
        min={1}
        value={value.wavelength}
        onChange={set("wavelength")}
        placeholder="850"
        error={errors.wavelength_nm}
      />
      <FormText
        label="Reach (m)"
        type="number"
        min={1}
        value={value.reach}
        onChange={set("reach")}
        placeholder="300"
        error={errors.reach_m}
      />
    </div>
  )
}

/** The free transceivers of a device - the inventory picker preset. */
function useFreeTransceiverSpec(
  deviceId: string
): ObjectPickerSpec<InventoryItemRow, InventoryItemRow> {
  return useMemo(() => {
    const scope = `device=${deviceId}&kind=transceiver&in_port=false`
    return {
      noun: "transceiver",
      pickerEndpoint: `/api/inventory-items/?${scope}&picker=1`,
      pickerQueryKey: ["free-transceivers", deviceId],
      optionLabel: (o) =>
        [o.name, o.part_id, o.serial_number].filter(Boolean).join(" · "),
      detailEndpoint: (id) => `/api/inventory-items/${id}/`,
      detailQueryKey: (id) => ["inventory-item", id],
      listEndpoint: `/api/inventory-items/?${scope}`,
      searchHint: "Search name…",
      filters: [],
      columns: [
        { header: "Name", cell: (r) => r.name },
        {
          header: "Part ID",
          cell: (r) => (
            <span className="font-mono text-xs">{r.part_id || "-"}</span>
          ),
        },
        {
          header: "Serial",
          cell: (r) => (
            <span className="font-mono text-xs">{r.serial_number || "-"}</span>
          ),
        },
      ],
    }
  }, [deviceId])
}

/**
 * Set the transceiver in a port: one of the device's free transceivers, or
 * a new one created in place.
 */
export function TransceiverDialog({
  iface,
  open,
  onOpenChange,
}: {
  iface: Pick<Interface, "id" | "name" | "device" | "transceiver">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const current = iface.transceiver ?? null
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [mode, setMode] = useState<"pick" | "new">("pick")
  const [picked, setPicked] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [partId, setPartId] = useState("")
  const [serial, setSerial] = useState("")
  const [facts, setFacts] = useState<TransceiverFacts>(NO_FACTS)
  const spec = useFreeTransceiverSpec(iface.device.id)

  useEffect(() => {
    if (!open) return
    setMode("pick")
    setPicked(null)
    setName(`${iface.name} optic`)
    setPartId("")
    setSerial("")
    setFacts(NO_FACTS)
    reset()
  }, [open, iface.name, reset])

  const save = useMutation({
    mutationFn: async () => {
      const seat = (id: string, interfaceId: string | null) =>
        api<InventoryItemRow>(`/api/inventory-items/${id}/`, {
          method: "PATCH",
          body: JSON.stringify({ interface_id: interfaceId }),
        })
      let id = picked
      if (mode === "new") {
        // Created first, so a refused form changes nothing; seated at once
        // when the port is free.
        const made = await api<InventoryItemRow>("/api/inventory-items/", {
          method: "POST",
          body: JSON.stringify({
            device_id: iface.device.id,
            name: name.trim(),
            kind: "transceiver",
            part_id: partId.trim(),
            serial_number: serial.trim(),
            interface_id: current ? null : iface.id,
            ...factsPayload(facts),
          }),
        })
        if (!current) return made
        id = made.id
      }
      if (!id) throw new Error("Pick a transceiver.")
      // A port holds one: the one there now comes out first.
      if (current && current.id !== id) await seat(current.id, null)
      return seat(id, iface.id)
    },
    onSuccess: () => {
      toast.success("Transceiver set")
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
    onSettled: () => invalidateTransceiver(qc, iface),
  })

  const ready = mode === "pick" ? !!picked : !!name.trim()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Set transceiver · {iface.name}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ready) save.mutate()
          }}
          className="grid gap-4"
        >
          <SegmentedTabs
            label="Transceiver source"
            items={[
              { value: "pick", label: "From inventory" },
              { value: "new", label: "New" },
            ]}
            value={mode}
            onValueChange={setMode}
          />
          {mode === "pick" ? (
            <ObjectPicker
              spec={spec}
              label="Transceiver"
              value={picked}
              onChange={setPicked}
              placeholder="Select a transceiver…"
              emptyText="No free transceivers on this device."
              error={fieldErrors.interface_id}
            />
          ) : (
            <>
              <FormText
                label="Name"
                required
                value={name}
                onChange={setName}
                error={fieldErrors.name}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormText
                  label="Part ID"
                  value={partId}
                  onChange={setPartId}
                  placeholder="SFP-10G-SR"
                  mono
                  error={fieldErrors.part_id}
                />
                <FormText
                  label="Serial"
                  value={serial}
                  onChange={setSerial}
                  mono
                  error={fieldErrors.serial_number}
                />
              </div>
              <TransceiverFactFields
                value={facts}
                onChange={setFacts}
                errors={fieldErrors}
              />
              {fieldErrors.interface_id && (
                <p className="text-sm text-destructive">
                  {fieldErrors.interface_id}
                </p>
              )}
            </>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel="Set transceiver"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

function invalidateTransceiver(
  qc: ReturnType<typeof useQueryClient>,
  iface: Pick<Interface, "id" | "device">
) {
  qc.invalidateQueries({ queryKey: ["interface", iface.id] })
  qc.invalidateQueries({ queryKey: ["interfaces"] })
  qc.invalidateQueries({ queryKey: ["device-inventory", iface.device.id] })
  qc.invalidateQueries({ queryKey: ["free-transceivers", iface.device.id] })
  qc.invalidateQueries({ queryKey: ["device-leds"] })
  qc.invalidateQueries({ queryKey: ["interface-parts", iface.id] })
}

/** The Overview's Transceiver value: what the port holds, with Set and
 * Remove for an editor. Removing unlinks it; the item stays in the
 * device's inventory. */
export function TransceiverValue({
  iface,
  canEdit,
}: {
  iface: Pick<Interface, "id" | "name" | "device" | "transceiver">
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const t = iface.transceiver ?? null
  const remove = useMutation({
    mutationFn: () =>
      api<InventoryItemRow>(`/api/inventory-items/${t!.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ interface_id: null }),
      }),
    onSuccess: () => {
      invalidateTransceiver(qc, iface)
      toast.success("Transceiver removed")
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {t ? (
        <span className="font-mono text-[13px]">{transceiverText(t)}</span>
      ) : (
        <span className="text-muted-foreground">-</span>
      )}
      {canEdit && (
        <span className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setOpen(true)}
          >
            {t ? "Change" : "Set"}
          </Button>
          {t && (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Removing…" : "Remove"}
            </Button>
          )}
          <TransceiverDialog iface={iface} open={open} onOpenChange={setOpen} />
        </span>
      )}
    </span>
  )
}
