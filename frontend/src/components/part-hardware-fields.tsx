import {
  INVENTORY_MEDIA_OPTIONS,
  STORAGE_UNITS,
  inventorySpeedSuggestions,
  type InventoryItemKind,
  type InventoryMedia,
  type StorageUnit,
} from "@/lib/api"
import { FormSelect, FormText } from "@/components/forms"

/** Which hardware facts make sense per part kind, and what to call them.
 *
 * The model stays one shape (media / speed / capacity_bytes are what the
 * Redfish reconciler writes for every kind); only the FORM is kind-aware.
 * Before this every kind wore the disk outfit - a CPU offering "7200 RPM /
 * PCIe 4.0 x4" and a capacity in GB. */
const KIND_FIELDS: Record<
  string,
  {
    media?: true
    speed?: { label: string; placeholder: string }
    capacity?: true
    /** CPU cores - the figure the hardware totals add up. */
    cores?: true
    /** Placeholder for the slot the part sits in. */
    slot: string
  }
> = {
  disk: { media: true, speed: { label: "Speed", placeholder: "7200 RPM" }, capacity: true, slot: "Bay 0" },
  cpu: { speed: { label: "Clock", placeholder: "2.4 GHz" }, cores: true, slot: "Socket 1" },
  ram: { speed: { label: "Speed", placeholder: "DDR4-3200 / 3200 MT/s" }, capacity: true, slot: "DIMM A1" },
  gpu: { speed: { label: "Bus", placeholder: "PCIe 4.0 x16" }, capacity: true, slot: "Slot 2" },
  fan: { speed: { label: "Speed", placeholder: "12000 RPM" }, slot: "Fan 1" },
  psu: { slot: "PSU 1" },
  controller: { speed: { label: "Bus", placeholder: "PCIe 3.0 x8" }, slot: "Slot 1" },
  transceiver: { speed: { label: "Speed", placeholder: "10G" }, slot: "Port 49" },
  // Pre-kind rows and genuinely odd parts: everything stays reachable.
  other: { media: true, speed: { label: "Speed", placeholder: "" }, capacity: true, slot: "" },
}

export function partFieldsFor(kind: string) {
  return KIND_FIELDS[kind] ?? KIND_FIELDS.other
}

/** The Media / Speed / Capacity block of the part dialogs, kind-aware.
 * Shared by the device part dialog and the device-type template editor so
 * the two can't drift apart again. */
export function PartHardwareFields({
  kind,
  media,
  onMedia,
  speed,
  onSpeed,
  capacity,
  onCapacity,
  capacityUnit,
  onCapacityUnit,
  slot,
  onSlot,
  cores,
  onCores,
  errors,
}: {
  kind: InventoryItemKind | string
  media: string
  onMedia: (v: InventoryMedia | "") => void
  speed: string
  onSpeed: (v: string) => void
  capacity: string
  onCapacity: (v: string) => void
  capacityUnit: StorageUnit
  onCapacityUnit: (v: StorageUnit) => void
  /** The slot the part sits in; the device dialog wires it, the device-type
   *  template editor leaves it out. */
  slot?: string
  onSlot?: (v: string) => void
  /** CPU cores; shown for kind=cpu when wired. */
  cores?: string
  onCores?: (v: string) => void
  errors: Record<string, string | undefined>
}) {
  const show = partFieldsFor(kind)
  const suggestions = inventorySpeedSuggestions(
    kind as InventoryItemKind,
    media as InventoryMedia
  )
  const withSlot = onSlot !== undefined
  const withCores = show.cores && onCores !== undefined
  const setCores = onCores ?? (() => undefined)
  return (
    <>
      {(show.media || show.speed || withSlot || withCores) && (
        <div className="grid grid-cols-2 gap-3">
          {show.media && (
            <FormSelect
              label="Media"
              value={media || null}
              onChange={(v) => onMedia((v ?? "") as InventoryMedia | "")}
              options={INVENTORY_MEDIA_OPTIONS}
              placeholder="-"
              error={errors.media}
            />
          )}
          {show.speed && (
            <FormText
              label={show.speed.label}
              value={speed}
              onChange={onSpeed}
              placeholder={show.speed.placeholder || suggestions[0] || ""}
              suggestions={suggestions}
              error={errors.speed}
            />
          )}
          {withCores && (
            <FormText
              label="Cores"
              type="number"
              value={cores ?? ""}
              onChange={setCores}
              placeholder="18"
              error={errors.cores}
            />
          )}
          {withSlot && (
            <FormText
              label="Slot"
              hint="optional"
              value={slot ?? ""}
              onChange={onSlot}
              placeholder={show.slot}
              error={errors.slot}
            />
          )}
        </div>
      )}
      {show.capacity && (
        <div className="grid grid-cols-[1fr_100px] gap-3">
          <FormText
            label={kind === "ram" ? "Size" : "Capacity"}
            type="number"
            value={capacity}
            onChange={onCapacity}
            error={errors.capacity_bytes}
          />
          <FormSelect
            label="Unit"
            value={capacityUnit}
            onChange={(v) => v && onCapacityUnit(v as StorageUnit)}
            options={STORAGE_UNITS.map((u) => ({
              value: u.value,
              label: u.value,
            }))}
          />
        </div>
      )}
    </>
  )
}
