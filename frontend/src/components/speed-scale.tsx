import { useQuery } from "@tanstack/react-query"

import { api, type Paginated, type Status } from "@/lib/api"
import { PORT_NEUTRAL, SPEED_TIERS } from "@/lib/faceplate-colors"
import { cn } from "@/lib/utils"

/**
 * The port speed legend, drawn as a compact COLORBAR (like a map scale), not a
 * wall of labelled chips: one segmented ramp FE→400G+ with the tier labels
 * under their segments, plus a short neutral row (free/disabled/down). Reads
 * in a glance, stays out of the way. Used identically under the 2D faceplate
 * and in the 3D room HUD so the two views can't teach different colours.
 */
export function SpeedScale({
  className,
  live,
  extras,
}: {
  className?: string
  /** Include the live-SNMP down/admin-down swatches. */
  live?: boolean
  /** Extra swatches appended INTO the single key row (e.g. trunk / live
   * dots), so callers never stack a second wrapping line. */
  extras?: React.ReactNode
}) {
  return (
    <div className={cn("grid w-fit gap-1.5", className)}>
      <div className="flex h-2 w-72 gap-px overflow-hidden rounded-full">
        {SPEED_TIERS.map((t) => (
          <span
            key={t.label}
            className="h-full flex-1"
            style={{ backgroundColor: t.hex }}
            title={t.label}
          />
        ))}
      </div>
      <div className="num flex w-72 text-[9px] leading-none text-muted-foreground">
        {SPEED_TIERS.map((t) => (
          <span key={t.label} className="flex-1 text-center">
            {t.label}
          </span>
        ))}
      </div>
      <div className="mt-0.5 flex w-72 flex-nowrap items-center gap-x-3 overflow-hidden text-[10px] leading-none whitespace-nowrap text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span
            className="h-2 w-2 rounded-[3px] border"
            style={{ borderColor: `${SPEED_TIERS[6].hex}66` }}
          />
          idle
        </span>
        <Swatch hex={PORT_NEUTRAL.disabled} label="off" dashed />
        {live && <Swatch hex={PORT_NEUTRAL.down} label="down" />}
        {extras}
      </div>
    </div>
  )
}

/**
 * Key for HARDWARE markers (disk bays etc.), coloured by their part's
 * lifecycle status. Colours come from the tenant's own Status catalog, so the
 * legend can never disagree with the badges. Rendered only when the faceplate
 * actually carries hardware markers.
 */
export function HardwareStatusKey({ className }: { className?: string }) {
  const statuses = useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=inventoryitem&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const rows = (statuses.data?.results ?? []).slice(0, 6)
  if (rows.length === 0) return null
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] leading-none text-muted-foreground",
        className
      )}
    >
      <span className="text-muted-foreground/70">Hardware</span>
      {rows.map((s) => (
        <Swatch key={s.id} hex={s.color || "#64748b"} label={s.name} />
      ))}
    </div>
  )
}

function Swatch({
  hex,
  label,
  dim,
  dashed,
}: {
  hex: string
  label: string
  dim?: boolean
  dashed?: boolean
}) {
  return (
    <span className="inline-flex items-center gap-1">
      <span
        className={cn("h-2 w-2 rounded-[3px]", dashed && "border border-dashed")}
        style={{
          backgroundColor: dashed ? "transparent" : hex,
          borderColor: dashed ? hex : undefined,
          opacity: dim ? 0.55 : 0.9,
        }}
      />
      {label}
    </span>
  )
}
