import { useCallback, useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type Paginated, type Status } from "@/lib/api"
import {
  mergeLegend,
  PORT_NEUTRAL,
  SPEED_TIERS,
  type LegendContent,
} from "@/lib/faceplate-colors"
import { cn } from "@/lib/utils"

// ─── who tells the legend what's on screen ───────────────────────────────────
// A legend must key the pixels, and only the renderer knows which markers
// resolved to something. So the renderers REPORT what they drew and the legend
// keys that — rather than the legend re-deriving it from the device (which is
// how you end up advertising 400G under a shelf of disk bays).

/** A panel reports its content under a stable key; `null` on unmount. */
export type LegendReporter = (
  key: string,
  content: LegendContent | null
) => void

/**
 * Collect what the panels below/around this legend actually draw. Several
 * panels can report (stack members, every rack in a 3D room) and the legend
 * shows their union.
 */
export function useLegendCollector(): {
  content: LegendContent
  report: LegendReporter
} {
  const [parts, setParts] = useState<Record<string, LegendContent>>({})
  const report = useCallback<LegendReporter>((key, content) => {
    setParts((prev) => {
      if (content === null) {
        if (!(key in prev)) return prev
        const next = { ...prev }
        delete next[key]
        return next
      }
      // Reporters memoize their content, so a repeat report of the same object
      // is a no-op — this is what keeps report → render → report from looping.
      if (prev[key] === content) return prev
      return { ...prev, [key]: content }
    })
  }, [])
  const content = useMemo(() => mergeLegend(Object.values(parts)), [parts])
  return { content, report }
}

/**
 * The renderer side of the collector: publish `content` while mounted, retract
 * it on unmount. `content` MUST be memoized by the caller — an object rebuilt
 * every render would report in a loop.
 */
export function useReportLegend(
  report: LegendReporter | undefined,
  key: string,
  content: LegendContent
) {
  useEffect(() => {
    if (!report) return
    report(key, content)
    return () => report(key, null)
  }, [report, key, content])
}

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
  tiers,
  states,
}: {
  className?: string
  /** Include the live-SNMP down/admin-down swatches. */
  live?: boolean
  /** Extra swatches appended INTO the single key row (e.g. trunk / live
   * dots), so callers never stack a second wrapping line. */
  extras?: React.ReactNode
  /** Tier labels actually drawn on this panel. Omit to show the full ramp
   * (unfiltered callers keep their old behaviour); pass an empty set and the
   * scale renders nothing — a disk-only panel shouldn't advertise 400G. */
  tiers?: Set<string>
  /** Neutral states actually drawn ("idle" / "off" / "down"), same contract. */
  states?: Set<string>
}) {
  // A legend for colours that aren't on screen is noise, and on a panel of
  // disk bays it's the majority of the legend.
  const ramp = tiers
    ? SPEED_TIERS.filter((t) => tiers.has(t.label))
    : SPEED_TIERS
  const shows = (k: string) => !states || states.has(k)
  if (ramp.length === 0 && !shows("idle") && !shows("off") && !shows("down"))
    return extras ? <div className={className}>{extras}</div> : null
  return (
    <div className={cn("grid w-fit gap-1.5", className)}>
      {ramp.length > 0 && (
        <div className="flex h-2 w-72 gap-px overflow-hidden rounded-full">
          {ramp.map((t) => (
            <span
              key={t.label}
              className="h-full flex-1"
              style={{ backgroundColor: t.hex }}
              title={t.label}
            />
          ))}
        </div>
      )}
      {ramp.length > 0 && (
        <div className="num flex w-72 text-[9px] leading-none text-muted-foreground">
          {ramp.map((t) => (
            <span key={t.label} className="flex-1 text-center">
              {t.label}
            </span>
          ))}
        </div>
      )}
      <div className="mt-0.5 flex w-72 flex-nowrap items-center gap-x-3 overflow-hidden text-[10px] leading-none whitespace-nowrap text-muted-foreground">
        {shows("idle") && (
          <span className="inline-flex items-center gap-1">
            <span
              className="h-2 w-2 rounded-[3px] border"
              style={{ borderColor: `${SPEED_TIERS[6].hex}66` }}
            />
            idle
          </span>
        )}
        {shows("off") && (
          <Swatch hex={PORT_NEUTRAL.disabled} label="off" dashed />
        )}
        {live && shows("down") && (
          <Swatch hex={PORT_NEUTRAL.down} label="down" />
        )}
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
export function HardwareStatusKey({
  className,
  statusIds,
}: {
  className?: string
  /** Status ids actually drawn on this panel. Omit for the whole catalog; pass
   * an empty set and nothing renders. A panel showing Active and Empty disks
   * shouldn't also claim Planned, Failed and Spare. */
  statusIds?: Set<string>
}) {
  const statuses = useQuery({
    queryKey: ["statuses", "inventoryitem"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=inventoryitem&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const rows = (statuses.data?.results ?? [])
    .filter((s) => !statusIds || statusIds.has(s.id))
    .slice(0, 6)
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
        className={cn(
          "h-2 w-2 rounded-[3px]",
          dashed && "border border-dashed"
        )}
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
