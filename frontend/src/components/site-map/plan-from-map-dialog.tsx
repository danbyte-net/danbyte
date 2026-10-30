import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"

import { api, ApiError } from "@/lib/api"
import type {
  FloorPlanFromMap,
  SiteMapOutline,
  SiteMapPayload,
  SiteMapSite,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Field, FormCombobox } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"

import {
  defaultPlanSite,
  planFrame,
  renderMapImage,
  TileReadError,
} from "./plan-from-map"
import type { Bbox } from "./plan-from-map"

type Basemap = "map" | "sat"

const fmtM = (m: number) =>
  m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`

/**
 * "New floor plan from this view": name, site, cell size and basemap for
 * the framed area, then render the view, create the site-wide plan with it
 * as the background and the outlines as areas, and open it. When the
 * browser can't read the tiles, offers the plan with the outlines only.
 */
export function PlanFromMapDialog({
  frame,
  tiles,
  sites,
  outlines,
  basemap: initialBasemap,
  onClose,
}: {
  /** The framed box and the map's zoom; null closes the dialog. */
  frame: { bbox: Bbox; zoom: number } | null
  tiles: SiteMapPayload["tiles"]
  sites: SiteMapSite[]
  outlines: SiteMapOutline[]
  basemap: Basemap
  onClose: () => void
}) {
  return (
    <Dialog open={!!frame} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="lg">
        {frame && (
          <PlanFromMapForm
            frame={frame}
            tiles={tiles}
            sites={sites}
            outlines={outlines}
            basemap={initialBasemap}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function PlanFromMapForm({
  frame,
  tiles,
  sites,
  outlines,
  basemap: initialBasemap,
  onClose,
}: {
  frame: { bbox: Bbox; zoom: number }
  tiles: SiteMapPayload["tiles"]
  sites: SiteMapSite[]
  outlines: SiteMapOutline[]
  basemap: Basemap
  onClose: () => void
}) {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [name, setName] = useState("Site plan")
  const [nameError, setNameError] = useState<string | undefined>()
  const [siteId, setSiteId] = useState<string | null>(() =>
    defaultPlanSite(frame.bbox, sites, outlines)
  )
  const [cellM, setCellM] = useState("1")
  const [basemap, setBasemap] = useState<Basemap>(initialBasemap)
  const [busy, setBusy] = useState<"render" | "save" | null>(null)
  const [tilesFailed, setTilesFailed] = useState(false)

  const cellMm = Math.round(Number(cellM) * 1000)
  const pf = useMemo(
    () => planFrame(frame.bbox, Number.isFinite(cellMm) ? cellMm : 1000),
    [frame.bbox, cellMm]
  )
  const siteOptions = useMemo(
    () => sites.map((s) => ({ value: s.id, label: s.name })),
    [sites]
  )
  const cellError =
    !Number.isFinite(cellMm) || cellMm < 50 || cellMm > 5000
      ? "0.05 to 5 m."
      : undefined
  const ready =
    !!name.trim() && !!siteId && !cellError && !("error" in pf) && !busy

  const create = async (withBackground: boolean) => {
    if ("error" in pf || !siteId) return
    const fd = new FormData()
    fd.append("name", name.trim())
    fd.append("site_id", siteId)
    fd.append(
      "bbox",
      JSON.stringify([pf.bbox.south, pf.bbox.west, pf.bbox.north, pf.bbox.east])
    )
    fd.append("cell_mm", String(pf.cellMm))
    try {
      if (withBackground) {
        setBusy("render")
        const cfg =
          basemap === "sat"
            ? tiles.satellite
            : { url: tiles.url, attribution: tiles.attribution }
        try {
          const img = await renderMapImage({
            bbox: pf.bbox,
            mapZoom: frame.zoom,
            template: cfg.url,
            attribution: cfg.attribution,
            jpeg: basemap === "sat",
          })
          fd.append("zoom", String(img.zoom))
          fd.append("basemap", basemap)
          fd.append(
            "background_image",
            img.blob,
            basemap === "sat" ? "site-map.jpg" : "site-map.png"
          )
        } catch (e) {
          if (e instanceof TileReadError) {
            setTilesFailed(true)
            return
          }
          throw e
        }
      }
      setBusy("save")
      const plan = await api<FloorPlanFromMap>("/api/floor-plans/from-map/", {
        method: "POST",
        body: fd,
      })
      qc.invalidateQueries({ queryKey: ["floor-plans"] })
      qc.invalidateQueries({ queryKey: ["floor-plan-stacks"] })
      if (plan.outlines_skipped.length)
        toast.warning(
          `Not copied: ${plan.outlines_skipped.join(", ")} (the outline doesn't fit the plan)`
        )
      onClose()
      nav({ to: "/floorplans/$id", params: { id: plan.id } })
    } catch (e) {
      const body =
        e instanceof ApiError ? (e.body as Record<string, unknown>) : null
      const nameErr = body && Array.isArray(body.name) ? body.name[0] : null
      if (typeof nameErr === "string") setNameError(nameErr)
      else apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New floor plan from this view</DialogTitle>
      </DialogHeader>
      <div className="grid gap-3">
        <Field label="Name" required error={nameError}>
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setNameError(undefined)
            }}
            className="h-8 text-sm"
          />
        </Field>
        <FormCombobox
          label="Site"
          required
          value={siteId}
          onChange={setSiteId}
          options={siteOptions}
          placeholder="Select site"
          searchPlaceholder="Search sites…"
          emptyText="No sites."
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cell size" hint="m" error={cellError}>
            <Input
              type="number"
              inputMode="decimal"
              min={0.05}
              max={5}
              step={0.1}
              value={cellM}
              onChange={(e) => setCellM(e.target.value)}
              className="num h-8 text-sm"
            />
          </Field>
          <Field label="Background">
            <SegmentedTabs<Basemap>
              value={basemap}
              onValueChange={(v) => {
                setBasemap(v)
                setTilesFailed(false)
              }}
              items={[
                { value: "map", label: "Map" },
                { value: "sat", label: "Satellite" },
              ]}
            />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground" data-testid="plan-frame">
          {"error" in pf ? (
            <span className="text-destructive">{pf.error}</span>
          ) : (
            <>
              <span className="num">
                {pf.gridWidth} × {pf.gridHeight}
              </span>{" "}
              cells of <span className="num">{pf.cellMm / 1000} m</span> ·{" "}
              <span className="num">
                {fmtM(pf.widthM)} × {fmtM(pf.heightM)}
              </span>
            </>
          )}
        </p>
        {tilesFailed && (
          <div
            role="alert"
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
          >
            The map tiles can&apos;t be read from this browser. Create the plan
            with the outlines only?
          </div>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {tilesFailed ? (
          <Button type="button" disabled={!ready} onClick={() => create(false)}>
            {busy ? "Creating…" : "Create without background"}
          </Button>
        ) : (
          <Button type="button" disabled={!ready} onClick={() => create(true)}>
            {busy ? "Creating…" : "Create"}
          </Button>
        )}
      </DialogFooter>
    </>
  )
}
