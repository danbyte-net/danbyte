import { useEffect, useRef, useState } from "react"
import type { UseMutationResult } from "@tanstack/react-query"
import { Eye, EyeOff } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { FloorPlan } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { SectionLabel } from "@/components/map-panel"
import { BarTip } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Slider } from "@/components/ui/slider"
import { TileReadError } from "@/components/site-map/plan-from-map"

import { DrawingUpload } from "./cad-upload"
import {
  BASEMAPS,
  captureMap,
  MapSnapshotDialog,
  useRefetchBackgrounds,
} from "./map-snapshot"
import type { Basemap } from "./map-snapshot"
import { bboxOf } from "./plan-geo"
import { useMapTiles } from "./plan-map-dialogs"
import type { CadDrawingState } from "./use-cad-drawing"

/** The plan's two background layers - the base map (a Site map snapshot)
 * and the floor drawing (a picture or a CAD drawing) over it: a popover
 * off the toolbar on a wide screen, a dialog from More on a narrow one. */
export function BackgroundControls({
  plan,
  cad,
  uploadBackground,
  patchPlan,
  onImageOverDrawing,
}: {
  plan: FloorPlan
  cad: CadDrawingState
  uploadBackground: UseMutationResult<FloorPlan, Error, File | null>
  patchPlan: UseMutationResult<FloorPlan, Error, Record<string, unknown>>
  /** An image picked while the plan has a drawing - it replaces the
   * drawing, after a confirm. */
  onImageOverDrawing: (file: File) => void
}) {
  return (
    <>
      <MapLayer plan={plan} patchPlan={patchPlan} />
      <FloorLayer
        plan={plan}
        cad={cad}
        uploadBackground={uploadBackground}
        patchPlan={patchPlan}
        onImageOverDrawing={onImageOverDrawing}
      />
    </>
  )
}

/** A layer's heading with its eye. */
function LayerHead({
  label,
  shown,
  onToggle,
  disabled,
}: {
  label: string
  shown: boolean
  onToggle?: () => void
  disabled?: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <SectionLabel className="mb-0">{label}</SectionLabel>
      {onToggle && (
        <BarTip
          tip={
            shown
              ? `Hide ${label.toLowerCase()}`
              : `Show ${label.toLowerCase()}`
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={
              shown
                ? `Hide ${label.toLowerCase()}`
                : `Show ${label.toLowerCase()}`
            }
            aria-pressed={shown}
            disabled={disabled}
            onClick={onToggle}
          >
            {shown ? <Eye /> : <EyeOff />}
          </Button>
        </BarTip>
      )}
    </div>
  )
}

/** An opacity slider that saves when let go. */
function Opacity({
  value,
  onCommit,
  label,
}: {
  value: number
  onCommit: (v: number) => void
  label: string
}) {
  const [v, setV] = useState(value)
  useEffect(() => setV(value), [value])
  return (
    <div className="grid gap-1">
      <span className="text-[11px] text-muted-foreground">
        Opacity · <span className="num">{v}%</span>
      </span>
      <Slider
        min={0}
        max={100}
        step={1}
        value={[v]}
        aria-label={label}
        onValueChange={([x]) => setV(x)}
        onValueCommit={([x]) => onCommit(x)}
      />
    </div>
  )
}

function MapLayer({
  plan,
  patchPlan,
}: {
  plan: FloorPlan
  patchPlan: UseMutationResult<FloorPlan, Error, Record<string, unknown>>
}) {
  const { formatDate } = useDateFormat()
  const m = plan.base_map ?? null
  const tiles = useMapTiles(!!m)
  const refetch = useRefetchBackgrounds()
  const [pick, setPick] = useState(false)
  const [editArea, setEditArea] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<"update" | "remove" | null>(null)
  const shown = !!plan.map_visible

  const update = async (basemap: Basemap) => {
    if (!plan.geo) return
    setBusy("update")
    try {
      await captureMap(
        plan,
        tiles,
        basemap,
        bboxOf(plan.geo),
        plan.geo.zoom ?? m?.zoom ?? 18,
        false
      )
      refetch()
      toast.success("Map updated")
    } catch (e) {
      if (e instanceof TileReadError)
        toast.error("The map tiles can't be read from this browser.")
      else apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy("remove")
    try {
      await api(`/api/floor-plans/${plan.id}/map/`, { method: "DELETE" })
      refetch()
      setConfirm(false)
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  const levels = m?.floors ?? 1
  return (
    <div className="grid gap-2" data-part="map-layer">
      <LayerHead
        label="Map"
        shown={shown}
        onToggle={m ? () => patchPlan.mutate({ map_shown: !shown }) : undefined}
        disabled={patchPlan.isPending}
      />
      {m ? (
        <>
          {m.captured_at && (
            <p className="text-xs text-muted-foreground">
              Map captured {formatDate(m.captured_at)}
              {levels > 1 && (
                <>
                  {" "}
                  · <span className="num">{levels}</span> levels
                </>
              )}
            </p>
          )}
          {plan.geo && (
            <SegmentedTabs<Basemap>
              value={m.basemap}
              onValueChange={(v) => v !== m.basemap && void update(v)}
              items={BASEMAPS}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {plan.geo && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => void update(m.basemap)}
              >
                {busy === "update" ? "Updating…" : "Update snapshot"}
              </Button>
            )}
            {plan.geo && (
              <Button
                variant="outline"
                size="sm"
                disabled={!!busy}
                onClick={() => setEditArea(true)}
              >
                Edit area…
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              disabled={!!busy}
              onClick={() => setConfirm(true)}
            >
              Remove
            </Button>
          </div>
          {shown && (
            <Opacity
              label="Map opacity"
              value={plan.map_opacity ?? 60}
              onCommit={(v) => patchPlan.mutate({ map_opacity: v })}
            />
          )}
        </>
      ) : (
        <div>
          <Button variant="outline" size="sm" onClick={() => setPick(true)}>
            From site map…
          </Button>
        </div>
      )}
      <MapSnapshotDialog plan={plan} open={pick} onOpenChange={setPick} />
      <MapSnapshotDialog
        plan={plan}
        mode="area"
        open={editArea}
        onOpenChange={setEditArea}
      />
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Remove map"
        description={
          levels > 1
            ? `The map goes from all ${levels} levels of this floor plan.`
            : undefined
        }
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={busy === "remove"}
        onConfirm={() => void remove()}
      />
    </div>
  )
}

function FloorLayer({
  plan,
  cad,
  uploadBackground,
  patchPlan,
  onImageOverDrawing,
}: {
  plan: FloorPlan
  cad: CadDrawingState
  uploadBackground: UseMutationResult<FloorPlan, Error, File | null>
  patchPlan: UseMutationResult<FloorPlan, Error, Record<string, unknown>>
  onImageOverDrawing: (file: File) => void
}) {
  const fileInput = useRef<HTMLInputElement>(null)
  const has = !!plan.background_image || !!plan.drawing
  const shown = plan.background_shown !== false
  return (
    <div className="mt-1 grid gap-2" data-part="floor-layer">
      <LayerHead
        label="Floor drawing"
        shown={shown}
        onToggle={
          has ? () => patchPlan.mutate({ background_shown: !shown }) : undefined
        }
        disabled={patchPlan.isPending}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          // One floor drawing: an image replaces the CAD drawing.
          if (f && plan.drawing) onImageOverDrawing(f)
          else if (f) uploadBackground.mutate(f)
          e.target.value = ""
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={uploadBackground.isPending}
          onClick={() => fileInput.current?.click()}
        >
          {plan.background_image ? "Replace image…" : "Upload image…"}
        </Button>
        {plan.background_image && (
          <Button
            variant="ghost"
            size="sm"
            disabled={uploadBackground.isPending}
            onClick={() => uploadBackground.mutate(null)}
          >
            Remove
          </Button>
        )}
      </div>
      <DrawingUpload cad={cad} hasImage={!!plan.background_image} />

      {shown && plan.background_image && (
        <Opacity
          label="Floor drawing opacity"
          value={plan.background_opacity}
          onCommit={(v) => patchPlan.mutate({ background_opacity: v })}
        />
      )}
      {shown && !plan.background_image && cad.drawing?.status === "ready" && (
        <Opacity
          label="Floor drawing opacity"
          value={cad.placement.opacity}
          onCommit={(v) => cad.change({ opacity: v })}
        />
      )}
    </div>
  )
}
