import { useEffect, useMemo, useState } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanExpanded,
  FloorPlanGeo,
  FloorPlanOutlineOffer,
  SiteMapPayload,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { ColorBadge } from "@/components/cells/color-badge"
import { Field, FormCheckbox } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  renderMapImage,
  TileReadError,
} from "@/components/site-map/plan-from-map"
import type { Bbox } from "@/components/site-map/plan-from-map"

import { ExpandMap } from "./expand-map"
import { bboxOf, cellsFromMetres, expandFrame, NO_GROWTH } from "./plan-geo"
import type { AnchoredPlan, Sides } from "./plan-geo"

type Basemap = "map" | "sat"

const BASEMAPS = [
  { value: "map" as const, label: "Map" },
  { value: "sat" as const, label: "Satellite" },
]

const fmtM = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m * 10) / 10} m`

/** "Map captured 31 Oct 2026", or null for a plan with no map background. */
export function capturedLabel(
  geo: FloorPlanGeo | null | undefined,
  formatDate: (v: string) => string
): string | null {
  if (!geo?.captured_at) return null
  return `Map captured ${formatDate(geo.captured_at)}`
}

/** The deployment's tile servers - the Site map's own query. */
export function useMapTiles(enabled: boolean) {
  return useQuery({
    queryKey: ["site-map"],
    queryFn: () => api<SiteMapPayload>("/api/site-map/"),
    enabled,
    staleTime: 60_000,
  }).data?.tiles
}

/** Render `bbox` from the tile server for a plan's background. Rejects with
 * `TileReadError` when the browser can't read the tiles. */
export async function renderPlanMap(
  tiles: SiteMapPayload["tiles"] | undefined,
  basemap: Basemap,
  bbox: Bbox,
  zoom: number
) {
  if (!tiles) throw new TileReadError("No map tiles are set up.")
  const cfg =
    basemap === "sat"
      ? tiles.satellite
      : { url: tiles.url, attribution: tiles.attribution }
  return renderMapImage({
    bbox,
    mapZoom: zoom,
    template: cfg.url,
    attribution: cfg.attribution,
    jpeg: basemap === "sat",
  })
}

function useRefetchPlan(planId: string) {
  const qc = useQueryClient()
  return () => {
    for (const key of [
      ["floor-plan", planId],
      ["floor-plan-contents", planId],
      ["floor-plan-state", planId],
      ["floor-plan-cable-paths", planId],
      ["floor-plan-stack"],
      ["floor-plans"],
      ["site-map"],
    ])
      void qc.invalidateQueries({ queryKey: key })
  }
}

const anchored = (plan: FloorPlan): plan is FloorPlan & AnchoredPlan =>
  !!plan.geo

// ── Re-import outlines ────────────────────────────────────────────────────

/** The Site map outlines inside the plan's box that no area on it stands
 * for yet, ticked, to add as areas. Null while loading; [] for none. */
async function offeredOutlines(planId: string) {
  const r = await api<{ outlines: FloorPlanOutlineOffer[] }>(
    `/api/floor-plans/${planId}/import-outlines/`,
    { method: "POST", body: JSON.stringify({ dry_run: true }) }
  )
  return r.outlines
}

function OutlinesStep({
  planId,
  offered,
  onDone,
}: {
  planId: string
  offered: FloorPlanOutlineOffer[]
  onDone: () => void
}) {
  const refetch = useRefetchPlan(planId)
  const [ticked, setTicked] = useState<Set<string>>(
    () => new Set(offered.map((o) => o.id))
  )
  const [busy, setBusy] = useState(false)
  const add = async () => {
    setBusy(true)
    try {
      const r = await api<{ created: number; skipped: string[] }>(
        `/api/floor-plans/${planId}/import-outlines/`,
        { method: "POST", body: JSON.stringify({ apply: [...ticked] }) }
      )
      refetch()
      if (r.skipped.length) toast.warning(`Not copied: ${r.skipped.join(", ")}`)
      toast.success(
        r.created === 1 ? "1 area added" : `${r.created} areas added`
      )
      onDone()
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <DialogHeader>
        <DialogTitle>New outlines on the map</DialogTitle>
      </DialogHeader>
      <div
        className="grid max-h-72 gap-0.5 overflow-y-auto"
        role="list"
        aria-label="Outlines"
      >
        {offered.map((o) => (
          <div key={o.id} role="listitem" className="flex items-center gap-2">
            <FormCheckbox
              label={o.label || o.location?.name || "Outline"}
              checked={ticked.has(o.id)}
              onChange={(v) =>
                setTicked((prev) => {
                  const next = new Set(prev)
                  if (v) next.add(o.id)
                  else next.delete(o.id)
                  return next
                })
              }
              className="flex-1 rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            {o.location && (
              <ColorBadge name={o.location.name} color={o.color} />
            )}
          </div>
        ))}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Skip
        </Button>
        <Button
          type="button"
          disabled={busy || ticked.size === 0}
          onClick={() => void add()}
        >
          {busy ? "Adding…" : `Add ${ticked.size} as areas`}
        </Button>
      </DialogFooter>
    </>
  )
}

/** After a refresh or an expand: offer the new outlines, or close. */
function useOutlinesStep(planId: string, close: () => void) {
  const [offered, setOffered] = useState<FloorPlanOutlineOffer[] | null>(null)
  const next = async () => {
    try {
      const list = await offeredOutlines(planId)
      if (list.length) setOffered(list)
      else close()
    } catch {
      // Outlines are optional; the map work is done.
      close()
    }
  }
  return { offered, next }
}

// ── Refresh map ───────────────────────────────────────────────────────────

/**
 * **Refresh map**: render the plan's box again from the current tiles (map
 * or satellite) and make it the background. Everything drawn stays put.
 */
export function RefreshMapDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: FloorPlan
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open && anchored(plan) && (
          <RefreshForm plan={plan} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RefreshForm({
  plan,
  onClose,
}: {
  plan: FloorPlan & AnchoredPlan
  onClose: () => void
}) {
  const { formatDate } = useDateFormat()
  const tiles = useMapTiles(true)
  const refetch = useRefetchPlan(plan.id)
  const [basemap, setBasemap] = useState<Basemap>(plan.geo.basemap ?? "map")
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const outlines = useOutlinesStep(plan.id, onClose)
  const captured = capturedLabel(plan.geo, formatDate)

  const refresh = async () => {
    setBusy(true)
    try {
      let img
      try {
        img = await renderPlanMap(
          tiles,
          basemap,
          bboxOf(plan.geo),
          plan.geo.zoom ?? 18
        )
      } catch (e) {
        if (e instanceof TileReadError) {
          setFailed(true)
          return
        }
        throw e
      }
      const fd = new FormData()
      fd.append("map_refresh", "1")
      fd.append("basemap", basemap)
      fd.append("zoom", String(img.zoom))
      fd.append(
        "background_image",
        img.blob,
        basemap === "sat" ? "site-map.jpg" : "site-map.png"
      )
      await api<FloorPlan>(`/api/floor-plans/${plan.id}/background/`, {
        method: "POST",
        body: fd,
      })
      refetch()
      toast.success("Map refreshed")
      await outlines.next()
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }

  if (outlines.offered)
    return (
      <OutlinesStep
        planId={plan.id}
        offered={outlines.offered}
        onDone={onClose}
      />
    )
  return (
    <>
      <DialogHeader>
        <DialogTitle>Refresh map</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <Field label="Background">
          <SegmentedTabs<Basemap>
            value={basemap}
            onValueChange={(v) => {
              setBasemap(v)
              setFailed(false)
            }}
            items={BASEMAPS}
          />
        </Field>
        {captured && (
          <p className="text-xs text-muted-foreground">{captured}</p>
        )}
        {failed && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          >
            The map tiles can&apos;t be read from this browser. The background
            stays as it is.
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {failed ? "Close" : "Cancel"}
        </Button>
        <Button
          type="button"
          disabled={busy || failed}
          onClick={() => void refresh()}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </DialogFooter>
    </>
  )
}

// ── Expand ────────────────────────────────────────────────────────────────

const SIDE_FIELDS: { side: keyof Sides; label: string }[] = [
  { side: "north", label: "North" },
  { side: "east", label: "East" },
  { side: "south", label: "South" },
  { side: "west", label: "West" },
]

/**
 * **Expand**: grow the plan's box - drag its sides on the small map or
 * type metres per side. Everything on the plan keeps its real-world place;
 * the background is rendered for the new box.
 */
export function ExpandPlanDialog({
  plan,
  open,
  onOpenChange,
}: {
  plan: FloorPlan
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        {open && anchored(plan) && (
          <ExpandForm plan={plan} onClose={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function ExpandForm({
  plan,
  onClose,
}: {
  plan: FloorPlan & AnchoredPlan
  onClose: () => void
}) {
  const tiles = useMapTiles(true)
  const refetch = useRefetchPlan(plan.id)
  const [sides, setSides] = useState<Sides>(NO_GROWTH)
  // What each metres box reads while it is typed in.
  const [typed, setTyped] = useState<Partial<Record<keyof Sides, string>>>({})
  const [basemap, setBasemap] = useState<Basemap>(plan.geo.basemap ?? "map")
  const [busy, setBusy] = useState(false)
  const outlines = useOutlinesStep(plan.id, onClose)
  const ef = useMemo(() => expandFrame(plan, sides), [plan, sides])
  const cellM = plan.cell_mm / 1000

  useEffect(() => setTyped({}), [plan.id])

  const setSide = (side: keyof Sides, cells: number) =>
    setSides((prev) => ({ ...prev, [side]: Math.max(0, cells) }))

  const apply = async () => {
    if (ef.error) return
    setBusy(true)
    try {
      const fd = new FormData()
      fd.append(
        "bbox",
        JSON.stringify([
          ef.bbox.south,
          ef.bbox.west,
          ef.bbox.north,
          ef.bbox.east,
        ])
      )
      fd.append("version", plan.updated_at)
      fd.append("basemap", basemap)
      let rendered = true
      try {
        const img = await renderPlanMap(
          tiles,
          basemap,
          ef.bbox,
          plan.geo.zoom ?? 18
        )
        fd.append("zoom", String(img.zoom))
        fd.append(
          "background_image",
          img.blob,
          basemap === "sat" ? "site-map.jpg" : "site-map.png"
        )
      } catch (e) {
        if (!(e instanceof TileReadError)) throw e
        rendered = false
      }
      const r = await api<FloorPlanExpanded>(
        `/api/floor-plans/${plan.id}/expand/`,
        { method: "POST", body: fd }
      )
      refetch()
      if (!rendered && r.expanded.background !== "none")
        toast.warning(
          "The map tiles can't be read from this browser: the old background stays where it was. Refresh map once they can be."
        )
      else toast.success(`Expanded to ${r.grid_width} × ${r.grid_height} cells`)
      await outlines.next()
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }

  if (outlines.offered)
    return (
      <OutlinesStep
        planId={plan.id}
        offered={outlines.offered}
        onDone={onClose}
      />
    )
  return (
    <>
      <DialogHeader>
        <DialogTitle>Expand</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <ExpandMap
          plan={plan}
          sides={sides}
          onChange={(side, cells) => {
            setSide(side, cells)
            setTyped((t) => ({ ...t, [side]: undefined }))
          }}
          tiles={tiles}
          basemap={basemap}
        />
        <div className="grid grid-cols-4 gap-3">
          {SIDE_FIELDS.map(({ side, label }) => (
            <Field key={side} label={label} hint="m">
              <Input
                type="number"
                inputMode="decimal"
                min={0}
                step={cellM}
                aria-label={`${label} (m)`}
                value={typed[side] ?? String(+(sides[side] * cellM).toFixed(3))}
                onChange={(e) => {
                  const v = e.target.value
                  setTyped((t) => ({ ...t, [side]: v }))
                  setSide(side, cellsFromMetres(plan, Number(v)))
                }}
                onBlur={() => setTyped((t) => ({ ...t, [side]: undefined }))}
                className="num h-8 text-sm"
              />
            </Field>
          ))}
        </div>
        <Field label="Background">
          <SegmentedTabs<Basemap>
            value={basemap}
            onValueChange={setBasemap}
            items={BASEMAPS}
          />
        </Field>
        <p className="text-xs text-muted-foreground" data-testid="expand-frame">
          {ef.error &&
          (sides.north || sides.east || sides.south || sides.west) ? (
            <span className="text-destructive">{ef.error}</span>
          ) : (
            <>
              <span className="num">
                {ef.gridWidth} × {ef.gridHeight}
              </span>{" "}
              cells of <span className="num">{cellM} m</span> ·{" "}
              <span className="num">
                {fmtM(ef.widthM)} × {fmtM(ef.heightM)}
              </span>
            </>
          )}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={busy || !!ef.error}
          onClick={() => void apply()}
        >
          {busy ? "Expanding…" : "Expand"}
        </Button>
      </DialogFooter>
    </>
  )
}
