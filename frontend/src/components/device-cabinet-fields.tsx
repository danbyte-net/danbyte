import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Cabinet, Device, DeviceTypeMini, Paginated } from "@/lib/api"
import {
  PROFILE_LABELS,
  fmtGaps,
  freeGaps,
  railSpans,
} from "@/lib/din-geometry"
import { CabinetPicker } from "@/components/cabinet-picker"
import { FormCombobox, FormText } from "@/components/forms"

/** The devices on one rail - what the offset's hint reads the free gaps
 * from. */
export function useRailDevices(railId: string | null | undefined) {
  return useQuery({
    queryKey: ["din-rail-devices", railId],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?din_rail=${railId}&page_size=500`),
    enabled: !!railId,
  })
}

/**
 * A device's place in a cabinet, the device form's alternative to a rack:
 * the cabinet (at the device's site, or any while it has none), one of its
 * rails, and the offset from the rail's left end. A blank offset lets the
 * server take the first gap the device fits in; the hint lists the rail's
 * free gaps, this device's own span left out.
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
  /** Rails of a profile the type does not mount on are offered disabled. */
  deviceType: Pick<DeviceTypeMini, "din_profiles"> | undefined
  errors: Record<string, string | undefined>
}) {
  // The picked cabinet's rails - not a previous pick's, still loaded.
  const rails = cabinet && cabinet.id === cabinetId ? cabinet.rails : []
  const rail = rails.find((r) => r.id === railId)
  const onRail = useRailDevices(rail?.id)
  const gaps = rail
    ? freeGaps(rail.length_mm, railSpans(onRail.data?.results ?? [], deviceId))
    : []
  const profiles = deviceType?.din_profiles ?? []
  const gapHint =
    rail && onRail.data
      ? gaps.length
        ? `Free ${fmtGaps(gaps)}`
        : "Rail full"
      : undefined

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
          onChange={onRailChange}
          options={rails.map((r) => ({
            value: r.id,
            label: r.label,
            hint: PROFILE_LABELS[r.profile],
            disabled: profiles.length > 0 && !profiles.includes(r.profile),
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
          type="number"
          inputMode="decimal"
          min={0}
          step={0.1}
          value={offset}
          onChange={onOffsetChange}
          placeholder="First free"
          error={errors.din_offset_mm}
        />
      </div>
      {/* Under the row, not beside the Offset label: a hint there wraps in
          a half-width column and drops its input below the Rail's. */}
      {gapHint && (
        <p
          data-part="gaps"
          className="-mt-1.5 text-[10px] leading-snug text-muted-foreground"
        >
          {gapHint}
        </p>
      )}
    </>
  )
}
