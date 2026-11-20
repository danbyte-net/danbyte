import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  TRANSCEIVER_CONNECTOR_OPTIONS,
  TRANSCEIVER_STANDARDS,
} from "@/lib/api"
import type {
  AccessoryType,
  Interface,
  InterfaceTransceiver,
  InventoryItemRow,
  TransceiverConnector,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
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
import {
  RemovePartDialog,
  useDeviceSite,
  useStockSpec,
} from "@/components/stock-place"

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
        value={value.connector || null}
        onChange={(v) => set("connector")(v ?? "")}
        options={TRANSCEIVER_CONNECTOR_OPTIONS}
        noneLabel="-"
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

/** A pluggable's facts as the form's: its first part number names it, and
 * an MPO receptacle is the common 12-fibre one. */
export function pluggableFacts(a: AccessoryType): {
  partId: string
  facts: TransceiverFacts
} {
  const known = new Set<string>(
    TRANSCEIVER_CONNECTOR_OPTIONS.map((o) => o.value)
  )
  const c = a.connector === "mpo" ? "mpo-12" : a.connector
  return {
    partId: a.parts[0] ?? a.name,
    facts: {
      standard: a.standard,
      connector: known.has(c) ? (c as TransceiverConnector) : c ? "other" : "",
      wavelength: a.wavelength_nm != null ? String(a.wavelength_nm) : "",
      reach: a.reach_m != null ? String(a.reach_m) : "",
    },
  }
}

/** Transceiver pluggables as select groups: those that fit `portType`
 * first, then the rest (a 25G cage also takes 10G and 1G optics). */
export function pluggableGroups(
  parts: readonly AccessoryType[],
  portType: string
) {
  const opt = (a: AccessoryType) => ({ value: a.id, label: a.name })
  const fit = parts.filter((a) => a.fits.includes(portType))
  const rest = parts.filter((a) => !a.fits.includes(portType))
  return [
    { label: "Fits this port", options: fit.map(opt) },
    { label: "Other", options: rest.map(opt) },
  ].filter((g) => g.options.length > 0)
}

/**
 * Set the transceiver in a port: one of the device's free transceivers, one
 * from stock (docs/dcim/stock.md - those that fit the port, the device's
 * site first), or a new one created in place - from a pluggable, which
 * fills in its part number and facts. With nothing free on the device it
 * opens on From stock, and on New when stock has none either.
 */
export function TransceiverDialog({
  iface,
  open,
  onOpenChange,
}: {
  iface: Pick<Interface, "id" | "name" | "type" | "device" | "transceiver">
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const current = iface.transceiver ?? null
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [mode, setMode] = useState<"pick" | "stock" | "new">("pick")
  const [picked, setPicked] = useState<string | null>(null)
  const [stockPick, setStockPick] = useState<string | null>(null)
  const [name, setName] = useState("")
  const [partId, setPartId] = useState("")
  const [serial, setSerial] = useState("")
  const [facts, setFacts] = useState<TransceiverFacts>(NO_FACTS)
  const [pluggable, setPluggable] = useState<string | null>(null)
  const spec = useFreeTransceiverSpec(iface.device.id)
  const siteId = useDeviceSite(iface.device.id, open)
  const stockSpec = useStockSpec({
    kind: "transceiver",
    fits: iface.type || undefined,
    nearSite: siteId,
  })
  const { canDo } = useMe()
  const stock = useQuery({
    queryKey: ["stock-items", "transceiver", iface.type, "count"],
    queryFn: () =>
      api<{ count: number }>(
        `/api/inventory-items/?${new URLSearchParams({
          home: "stock",
          kind: "transceiver",
          ...(iface.type ? { fits: iface.type } : {}),
          page_size: "1",
        }).toString()}`
      ),
    enabled: open,
  })
  const free = useQuery({
    queryKey: ["free-transceivers", iface.device.id, "count"],
    queryFn: () =>
      api<{ count: number }>(
        `/api/inventory-items/?device=${iface.device.id}&kind=transceiver&in_port=false&page_size=1`
      ),
    enabled: open,
  })
  const parts = useQuery({
    queryKey: ["accessory-types", "transceivers"],
    queryFn: () =>
      apiAll<AccessoryType>("/api/accessory-types/?kind=transceiver"),
    enabled: open && canDo("accessorytype", "view"),
    staleTime: 10 * 60_000,
  })
  const partList = parts.data?.results ?? []
  const noneFree = free.data?.count === 0
  const noStock = stock.data?.count === 0

  useEffect(() => {
    if (!open) return
    setMode("pick")
    setPluggable(null)
    setPicked(null)
    setStockPick(null)
    setName(`${iface.name} optic`)
    setPartId("")
    setSerial("")
    setFacts(NO_FACTS)
    reset()
  }, [open, iface.name, reset])
  // Nothing spare on the device: start on From stock, else on New.
  useEffect(() => {
    if (!open || !noneFree || stock.data === undefined) return
    setMode(noStock ? "new" : "stock")
  }, [open, noneFree, noStock, stock.data])

  const pickPluggable = (id: string | null) => {
    setPluggable(id)
    const a = partList.find((p) => p.id === id)
    if (!a) return
    const { partId: pid, facts: f } = pluggableFacts(a)
    setPartId(pid)
    setFacts(f)
  }

  const chosen = partList.find((p) => p.id === pluggable) ?? null
  const save = useMutation({
    mutationFn: async () => {
      const seat = (id: string, interfaceId: string | null) =>
        api<InventoryItemRow>(`/api/inventory-items/${id}/`, {
          method: "PATCH",
          body: JSON.stringify({ interface_id: interfaceId }),
        })
      if (mode === "stock") {
        if (!stockPick) throw new Error("Pick a transceiver.")
        // A port holds one: the one there now stays on the device.
        if (current) await seat(current.id, null)
        return api<InventoryItemRow>(
          `/api/inventory-items/${stockPick}/move/`,
          {
            method: "POST",
            body: JSON.stringify({ interface_id: iface.id }),
          }
        )
      }
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
            // A generic part stands for no part number: name it by hand.
            ...(chosen && chosen.parts.length === 0
              ? { accessory_type_id: chosen.id }
              : {}),
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

  const ready =
    mode === "pick" ? !!picked : mode === "stock" ? !!stockPick : !!name.trim()
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
              { value: "pick", label: "On this device" },
              { value: "stock", label: "From stock" },
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
              emptyText="No spare transceivers on this device."
              error={fieldErrors.interface_id}
            />
          ) : mode === "stock" ? (
            <ObjectPicker
              spec={stockSpec}
              label="Transceiver"
              value={stockPick}
              onChange={setStockPick}
              placeholder="Select a transceiver…"
              emptyText="No transceivers in stock that fit."
              error={fieldErrors.interface_id}
            />
          ) : (
            <>
              {partList.length > 0 && (
                <FormSelect
                  label="Pluggable"
                  value={pluggable}
                  onChange={pickPluggable}
                  groups={pluggableGroups(partList, iface.type)}
                  options={[]}
                  noneLabel="-"
                />
              )}
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
  qc.invalidateQueries({ queryKey: ["stock-items"] })
  qc.invalidateQueries({ queryKey: ["inventory"] })
}

/** The Overview's Transceiver value: what the port holds, with Set and
 * Remove for an editor. Removing asks where it goes: to stock (the
 * default), kept on the device, or out as scrap or RMA. */
export function TransceiverValue({
  iface,
  canEdit,
}: {
  iface: Pick<Interface, "id" | "name" | "type" | "device" | "transceiver">
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [removing, setRemoving] = useState(false)
  const t = iface.transceiver ?? null
  const siteId = useDeviceSite(iface.device.id, removing)
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
              onClick={() => setRemoving(true)}
            >
              Remove
            </Button>
          )}
          <TransceiverDialog iface={iface} open={open} onOpenChange={setOpen} />
          {t && (
            <RemovePartDialog
              open={removing}
              onOpenChange={setRemoving}
              title={`Remove transceiver · ${iface.name}`}
              target={{
                moveEndpoint: `/api/inventory-items/${t.id}/move/`,
                deviceId: iface.device.id,
                siteId,
              }}
              onDone={() => invalidateTransceiver(qc, iface)}
            />
          )}
        </span>
      )}
    </span>
  )
}
