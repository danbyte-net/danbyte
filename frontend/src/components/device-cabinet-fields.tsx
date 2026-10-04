import { useEffect, useState } from "react"

import type { Cabinet } from "@/lib/api"
import {
  PROFILE_LABELS,
  firstFit,
  freeGaps,
  mountsOn,
  railSpans,
} from "@/lib/din-geometry"
import { CabinetPicker } from "@/components/cabinet-picker"
import { useCabinetDevices } from "@/components/cabinet-devices"
import { CabinetPlacement } from "@/components/cabinet-placement"
import type { PlacedType } from "@/components/cabinet-placement"
import { FormCombobox, FormText } from "@/components/forms"

/**
 * A device's place in a cabinet, the device form's alternative to a rack:
 * the cabinet (at the device's site, or any while it has none), one of its
 * rails, and the offset from the rail's left end. A rail picked fresh fills
 * the offset with the first gap the device fits in; one the user clears
 * stays blank, and lets the server take that gap.
 *
 * Under the fields, the cabinet's plate: its rails and the devices on them,
 * this device as an outline at its rail and offset. A click on a rail, a
 * drag or the arrow keys place it there and fill the fields; the line under
 * the plate lists the rail's free gaps, this device's own span left out, or
 * says why it can't go where it is.
 */
export function DeviceCabinetFields({
  siteId,
  cabinetId,
  onCabinetChange,
  cabinet,
  railId,
  onRailChange,
  offset,
  onOffsetChange,
  deviceId,
  deviceType,
  name = "",
  errors,
}: {
  siteId: string | null
  cabinetId: string | null
  onCabinetChange: (id: string | null) => void
  /** The picked cabinet, for its rails; undefined while it loads. */
  cabinet: Cabinet | undefined
  railId: string | null
  onRailChange: (id: string | null) => void
  offset: string
  onOffsetChange: (v: string) => void
  /** The device being edited: its own span is not in the way. */
  deviceId?: string
  /** Sizes the outline; rails of a profile it does not mount on are offered
   * disabled and drawn faint. */
  deviceType: PlacedType | undefined
  /** The device's name, written in the outline. */
  name?: string
  errors: Record<string, string | undefined>
}) {
  // The picked cabinet - not a previous pick's, still loaded.
  const picked = cabinet && cabinet.id === cabinetId ? cabinet : undefined
  const rails = picked?.rails ?? []
  const inCabinet = useCabinetDevices(picked?.id)
  const typed = offset.trim() === "" ? null : Number(offset)

  // The rail whose first free gap the offset is waiting to be filled with:
  // one picked while the offset was blank or another rail's - or opened
  // with, offset blank. Filled once the cabinet's devices and the type's
  // width are in; typing an offset first keeps what is typed.
  const [prefill, setPrefill] = useState<string | null>(() =>
    railId && offset.trim() === "" ? railId : null
  )
  const onCabinet = inCabinet.data?.results
  const width = deviceType?.width_mm
  useEffect(() => {
    if (!prefill) return
    if (prefill !== railId) {
      setPrefill(null)
      return
    }
    const rail = picked?.rails.find((r) => r.id === prefill)
    if (!rail || !onCabinet || width == null) return
    setPrefill(null)
    if (!mountsOn(deviceType, rail.profile)) return
    const taken = railSpans(
      onCabinet.filter((d) => d.din_rail?.id === rail.id),
      deviceId
    )
    const at = firstFit(freeGaps(rail.length_mm, taken), width)
    // Nothing fits: blank, and the plate says so.
    onOffsetChange(at == null ? "" : String(at))
  }, [
    prefill,
    railId,
    picked,
    onCabinet,
    width,
    deviceType,
    deviceId,
    onOffsetChange,
  ])

  const pickRail = (id: string | null) => {
    const fresh = offset.trim() === "" || (railId != null && id !== railId)
    setPrefill(id && fresh ? id : null)
    onRailChange(id)
  }

  return (
    <>
      <CabinetPicker
        siteId={siteId}
        value={cabinetId}
        onChange={onCabinetChange}
        noneLabel="No cabinet"
        placeholder="Select a cabinet…"
        error={errors.cabinet_id}
      />
      <div className="grid gap-3 @md:grid-cols-2">
        <FormCombobox
          label="Rail"
          value={railId}
          onChange={pickRail}
          options={rails.map((r) => ({
            value: r.id,
            label: r.label,
            hint: PROFILE_LABELS[r.profile],
            disabled: !mountsOn(deviceType, r.profile),
          }))}
          noneLabel="No rail"
          placeholder={cabinetId ? "Pick a rail…" : "Select a cabinet first"}
          searchPlaceholder="Search rails…"
          emptyText={cabinetId ? "No rails." : "Select a cabinet first."}
          disabled={!cabinetId}
          error={errors.din_rail_id}
        />
        <FormText
          label="Offset (mm)"
          info="From the rail's left end; blank takes the first free gap. On the plate below, click a rail to place the device, drag it along or onto another rail, or nudge it with the arrow keys - Shift moves 10 mm."
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          value={offset}
          onChange={(v) => {
            setPrefill(null)
            onOffsetChange(v)
          }}
          placeholder="First free"
          error={errors.din_offset_mm}
        />
      </div>
      {picked && (
        <CabinetPlacement
          cabinet={picked}
          devices={inCabinet.data?.results}
          deviceId={deviceId}
          type={deviceType}
          name={name}
          railId={railId}
          offset={typed}
          onPlace={(rail, at) => {
            // Put on a rail before the type is known: filled in once it is.
            setPrefill(at == null ? rail : null)
            onRailChange(rail)
            onOffsetChange(at == null ? "" : String(at))
          }}
        />
      )}
    </>
  )
}
