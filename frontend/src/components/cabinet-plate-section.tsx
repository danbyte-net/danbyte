import { useCallback, useLayoutEffect, useRef, useState } from "react"
import type { ReactNode, RefObject } from "react"
import { Minus, Move, Pencil, Plus } from "lucide-react"

import type {
  Cabinet,
  CabinetSizes,
  Device,
  DinRail,
  DinRailKey,
} from "@/lib/api"
import {
  DEFAULT_PLATE_VIEW,
  defaultZoom,
  fitScale,
  stepZoom,
  usePlateView,
  zoomScale,
} from "@/lib/cabinet-plate-view"
import type { PlateMode, PlateZoom } from "@/lib/cabinet-plate-view"
import { legendIsEmpty } from "@/lib/faceplate-colors"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  ArrangeActions,
  ArrangePlate,
  useArrangement,
} from "@/components/cabinet-arrange"
import { CabinetDeviceBodies } from "@/components/cabinet-devices"
import { CabinetElevation, plateView } from "@/components/cabinet-elevation"
import { CabinetExportMenu } from "@/components/cabinet-export-menu"
import { CabinetFaceplates } from "@/components/cabinet-faceplates"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import { FaceplateLegend } from "@/components/device-faceplate"
import type { PortTrace } from "@/components/device-faceplate"
import { InterfaceTraceDialog } from "@/components/interface-trace-dialog"
import { DinRailEditor } from "@/components/din-rail-editor"
import { FormCheckbox } from "@/components/forms"
import { BarIconButton } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useLegendCollector } from "@/components/speed-scale"

const MODES: { value: PlateMode; label: string }[] = [
  { value: "names", label: "Names" },
  { value: "images", label: "Images" },
  { value: "render", label: "Render" },
]

/** Until the column is measured, take it to be about this wide. */
const ASSUMED_COLUMN_PX = 480

/** The mounting plate on a cabinet's or a cabinet type's Overview: drawn to
 * scale with its rails - and a cabinet's devices on them - plus "Edit rails"
 * for whoever may change the parent. On a cabinet, **Arrange** lets whoever
 * may change devices move them about on the plate and save the lot.
 *
 * A cabinet's plate takes the rack elevation's controls: Names, Images or
 * Render, its labels on or off and a zoom - kept in this browser, so the
 * page reopens as it was left - and an Export menu of the drawing: PNG, SVG,
 * PDF and Print (cabinet-export-menu.tsx). `lead` goes first on
 * that toolbar (the cabinet page's 2D | 3D switch); `scene`, when given,
 * takes the drawing's place - the 3D view, which brings its own toolbar. */
export function CabinetPlateSection({
  sizes,
  rails,
  endpoint,
  railKey,
  editTitle,
  canEdit,
  devices,
  cabinet,
  actions,
  lead,
  scene,
}: {
  sizes: CabinetSizes
  rails: DinRail[]
  /** The parent's detail endpoint, which the editor PATCHes. */
  endpoint: string
  railKey: DinRailKey
  /** The editor's title, naming the parent. */
  editTitle: string
  canEdit: boolean
  /** A cabinet's devices, drawn on their rails. */
  devices?: Device[]
  /** The cabinet itself, whose devices Arrange moves. */
  cabinet?: Cabinet
  /** More of the heading's controls, before Edit rails. */
  actions?: ReactNode
  /** First on the drawing's toolbar. */
  lead?: ReactNode
  /** Drawn instead of the plate, toolbar and all. */
  scene?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const { canDo } = useMe()
  const arrangement = useArrangement(cabinet, devices)
  const arranging = arrangement.on && !!cabinet
  const canArrange =
    !!cabinet && cabinet.rails.length > 0 && canDo("device", "change")

  // The controls are for a cabinet's devices; a cabinet type's plate, or a
  // cabinet's with no rails to hang them on, is drawn as it always was.
  const controlled = !!cabinet && rails.length > 0
  const [stored, setView] = usePlateView()
  const view = controlled ? stored : DEFAULT_PLATE_VIEW
  // Render pauses while arranging: the placer draws the photos.
  const mode: PlateMode =
    arranging && view.mode === "render" ? "images" : view.mode
  const look = mode === "names" ? "names" : "images"
  // Labels off leaves Names without a word on it; the photo modes keep
  // the rails' labels to find their way by.
  const railTags = view.labels || mode !== "names"

  const [column, columnWidth] = useWidth()
  const frame = plateView(
    sizes.inner_width_mm,
    sizes.inner_height_mm,
    sizes.outer_width_mm,
    sizes.outer_height_mm
  )
  const fit = fitScale(columnWidth || ASSUMED_COLUMN_PX, frame)
  const pxPerMm = controlled ? zoomScale(view.zoom, fit) : undefined
  const zoomOut = stepZoom(view.zoom, fit, -1)
  const zoomIn = stepZoom(view.zoom, fit, 1)
  const setZoom = (zoom: PlateZoom | null) => {
    if (zoom != null) setView({ ...view, zoom })
  }
  const changeMode = (m: PlateMode) => {
    // Each mode starts at its own zoom, as on the rack.
    if (m !== mode) setView({ ...view, mode: m, zoom: defaultZoom(m, fit) })
  }

  // The drawing on screen: Render's PNG is a picture of it.
  const drawing = useRef<HTMLDivElement>(null)

  // The live faces' key: the colours they drew, and the live dot where any
  // device's ports carry SNMP facts.
  const { content: legend, report: onLegend } = useLegendCollector()
  const [live, setLive] = useState<ReadonlySet<string>>(() => new Set())
  const onLive = useCallback((id: string, on: boolean) => {
    setLive((prev) => {
      if (prev.has(id) === on) return prev
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Live faces: every device in Render, the photos with ports marked on
  // them in Images - as the rack's elevation draws them.
  const faces = mode !== "names" && !!devices?.length && pxPerMm != null
  // A cabled port pressed on a face: its run, in a dialog.
  const [trace, setTrace] = useState<PortTrace | null>(null)

  const elevation = (
    <CabinetElevation
      width={sizes.inner_width_mm}
      height={sizes.inner_height_mm}
      outerWidth={sizes.outer_width_mm}
      outerHeight={sizes.outer_height_mm}
      rails={rails.map((r) => ({ key: r.id, ...r }))}
      emptyText="No rails yet."
      railLabels={!devices?.length && railTags}
      pxPerMm={pxPerMm}
    >
      {devices && devices.length > 0 && (
        <CabinetDeviceBodies
          rails={rails}
          devices={devices}
          look={look}
          names={view.labels}
          railTags={railTags}
        />
      )}
    </CabinetElevation>
  )

  return (
    // A grid item no wider than its column, however far the drawing zooms:
    // the drawing scrolls in its frame instead.
    <section className="min-w-0">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Plate
        </h2>
        <div className="flex items-center gap-1">
          {arranging ? (
            <ArrangeActions arrangement={arrangement} />
          ) : (
            <>
              {actions}
              {canArrange && !scene && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1 h-6 px-2 text-xs"
                  onClick={arrangement.start}
                >
                  <Move className="h-3 w-3" /> Arrange
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  // Kept to the heading's line, so this card's top lines up
                  // with the cards beside it.
                  className="-my-1 h-6 px-2 text-xs"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3 w-3" /> Edit rails
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        {/* The column stays mounted whichever view is shown: its width is
            what the 2D plate fits to. */}
        <div ref={column}>
          {scene ?? (
            <>
              {(controlled || (lead && !arranging)) && (
                <div
                  data-part="plate-toolbar"
                  className="@container mb-3 flex flex-wrap items-center gap-x-3 gap-y-2"
                >
                  {!arranging && lead}
                  {controlled && (
                    <>
                      <SegmentedTabs<PlateMode>
                        value={mode}
                        onValueChange={changeMode}
                        items={
                          arranging
                            ? MODES.filter((m) => m.value !== "render")
                            : MODES
                        }
                      />
                      <FormCheckbox
                        label="Labels"
                        checked={view.labels}
                        onChange={(labels) => setView({ ...view, labels })}
                        className="items-center gap-1 text-[11px] text-muted-foreground"
                      />
                      <div className="flex items-center gap-1">
                        <BarIconButton
                          label="Zoom out"
                          disabled={!zoomOut}
                          onClick={() => setZoom(zoomOut)}
                        >
                          <Minus />
                        </BarIconButton>
                        <BarIconButton
                          label="Zoom in"
                          disabled={!zoomIn}
                          onClick={() => setZoom(zoomIn)}
                        >
                          <Plus />
                        </BarIconButton>
                      </div>
                      {!arranging && (
                        <CabinetExportMenu
                          cabinet={cabinet}
                          devices={devices ?? []}
                          mode={mode}
                          labels={view.labels}
                          railTags={railTags}
                          snapshot={drawing}
                          className="ml-auto"
                        />
                      )}
                    </>
                  )}
                </div>
              )}
              {arranging ? (
                <ArrangePlate
                  cabinet={cabinet}
                  arrangement={arrangement}
                  pxPerMm={pxPerMm}
                  look={look}
                  names={view.labels}
                  railTags={railTags}
                />
              ) : pxPerMm == null ? (
                elevation
              ) : (
                // Scrolls when the zoom draws it wider than the column; centred
                // while it is narrower, as the fitted plate always was.
                <div className="overflow-auto">
                  <div
                    ref={drawing}
                    data-part="drawing"
                    className="relative mx-auto w-max"
                  >
                    {elevation}
                    {faces && (
                      <CabinetFaceplates
                        rails={rails}
                        devices={devices}
                        frame={{ x: frame.x, y: frame.y, pxPerMm }}
                        mode={mode === "render" ? "render" : "images"}
                        labels={view.labels}
                        onLegend={onLegend}
                        onLive={onLive}
                        onTrace={setTrace}
                      />
                    )}
                  </div>
                </div>
              )}
              {faces && !arranging && !legendIsEmpty(legend) && (
                <FaceplateLegend
                  className="mt-3"
                  content={legend}
                  observed={live.size > 0}
                />
              )}
            </>
          )}
        </div>
      </div>
      <InterfaceTraceDialog
        target={
          trace?.kind === "interface"
            ? { id: trace.id, name: traceName(trace) }
            : null
        }
        onOpenChange={(o) => !o && setTrace(null)}
      />
      <CableTraceDialog
        target={
          trace?.kind === "cable"
            ? { id: trace.id, label: traceName(trace) }
            : null
        }
        onOpenChange={(o) => !o && setTrace(null)}
      />
      {canEdit && (
        <DinRailEditor
          open={editing}
          onOpenChange={setEditing}
          endpoint={endpoint}
          railKey={railKey}
          title={editTitle}
          sizes={sizes}
          rails={rails}
        />
      )}
    </section>
  )
}

/** A traced port as the dialog's title names it: `device:port`. */
function traceName(t: PortTrace): string {
  return t.device ? `${t.device}:${t.name}` : t.name
}

/** An element's width, px: read before the first paint, so the plate is
 * drawn at its fitted size from the start, and followed as it resizes. 0
 * without a layout. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setWidth(el.getBoundingClientRect().width)
    read()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}
