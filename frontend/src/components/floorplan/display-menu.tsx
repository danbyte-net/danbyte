import { SlidersHorizontal } from "lucide-react"

import { FormCheckbox } from "@/components/forms"
import { BarMenuTrigger } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { setPortLabelsShown, usePortLabelsShown } from "@/lib/port-labels-pref"
import { CABLE_SCALE_MAX, CABLE_SCALE_MIN } from "@/lib/render-quality"
import type { CableLook, RenderQualitySetting } from "@/lib/render-quality"
import { useMe } from "@/lib/use-me"
import { cn } from "@/lib/utils"

import { ColorBySelect } from "./color-by-select"
import type { PlanViewPrefs, ShellMode3D } from "./use-plan-view-prefs"

/** The bar's Display popover: what the 2D plan draws, and - in 3D - what the
 * room shows up close, its cabinet shell, cables and render quality. */
export function DisplayMenu({
  view3d,
  prefs,
}: {
  view3d: boolean
  prefs: PlanViewPrefs
}) {
  const {
    colorBy,
    labelFit,
    showFov,
    showZoneLabels,
    showTrays,
    showCableLinks,
    showPhotos,
    show3dU,
    show3dNames,
    names3dScope,
    names3dEdge,
    show3dCables,
    show3dAirflow,
    floorPeek,
    show3dWalls,
    show3dCeiling,
    shell3d,
    setShellMode,
    cableScale,
    setCableScale,
    cableLook,
    setCableLook,
    quality3d,
    setQuality3d,
    setViewPref,
  } = prefs
  // Port labels on this screen - the viewer's switch over the deployment's
  // choice, shared with the device page.
  const { faceplatePortLabels } = useMe()
  const portLabelsShown = usePortLabelsShown()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <SlidersHorizontal /> Display
        </BarMenuTrigger>
      </PopoverTrigger>
      {/* Two columns once the 3D block is in play. As one 224px stack
          this ran past the bottom of a laptop viewport and had to be
          scrolled inside; side by side it fits on screen. */}
      <PopoverContent
        align="end"
        collisionPadding={12}
        className={cn(
          "gap-1 p-2",
          view3d ? "grid w-[30rem] grid-cols-2 gap-x-3" : "w-56"
        )}
      >
        <div className="grid content-start gap-1">
          <ColorBySelect
            value={colorBy}
            onChange={(v) => setViewPref("color_by", v)}
          />
          <div className="my-1 h-px bg-border" />
          <FormCheckbox
            label="Fit labels to tiles"
            checked={labelFit}
            onChange={(v) => setViewPref("label_fit", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
          <FormCheckbox
            label="Camera FOV cones"
            checked={showFov}
            onChange={(v) => setViewPref("show_fov", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
          <FormCheckbox
            label="Zone labels"
            checked={showZoneLabels}
            onChange={(v) => setViewPref("show_zone_labels", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
          <FormCheckbox
            label="Photos"
            checked={showPhotos}
            onChange={(v) => setViewPref("show_photos", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
          <div className="my-1 h-px bg-border" />
          <FormCheckbox
            label="Cable trays"
            checked={showTrays}
            onChange={(v) => setViewPref("show_trays", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
          <FormCheckbox
            label="Cable links (A↔B)"
            checked={showCableLinks}
            onChange={(v) => setViewPref("show_cable_links", v)}
            className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
          />
        </div>
        {view3d && (
          <div className="grid content-start gap-1 border-l border-border pl-3">
            <span className="px-2 text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
              3D · shown up close
            </span>
            <FormCheckbox
              label="U numbers"
              checked={show3dU}
              onChange={(v) => setViewPref("show_3d_u", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            {faceplatePortLabels && (
              <FormCheckbox
                label="Port labels"
                checked={portLabelsShown}
                onChange={setPortLabelsShown}
                className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
              />
            )}
            <FormCheckbox
              label="Device names"
              checked={show3dNames}
              onChange={(v) => setViewPref("show_3d_names", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            {show3dNames && (
              <div className="grid gap-1.5 px-2 pb-1">
                <SegmentedTabs<"all" | "selected">
                  value={names3dScope}
                  onValueChange={(v) => setViewPref("show_3d_names_scope", v)}
                  items={[
                    { value: "all", label: "All racks" },
                    { value: "selected", label: "Highlighted rack" },
                  ]}
                />
                <FormCheckbox
                  label="Names off the gear"
                  checked={names3dEdge}
                  onChange={(v) => setViewPref("show_3d_names_edge", v)}
                  className="items-center rounded px-2 py-1 text-[13px] hover:bg-muted/60"
                />
              </div>
            )}
            <FormCheckbox
              label="Cables"
              checked={show3dCables}
              onChange={(v) => setViewPref("show_3d_cables", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            <FormCheckbox
              label="Airflow"
              checked={show3dAirflow}
              onChange={(v) => setViewPref("show_3d_airflow", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            <FormCheckbox
              label="Lift raised floor"
              checked={floorPeek}
              onChange={(v) => setViewPref("show_3d_floor_peek", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            <FormCheckbox
              label="Walls"
              checked={show3dWalls}
              onChange={(v) => setViewPref("show_3d_walls", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            <FormCheckbox
              label="Ceiling"
              checked={show3dCeiling}
              onChange={(v) => setViewPref("show_3d_ceiling", v)}
              className="items-center rounded px-2 py-1.5 text-[13px] hover:bg-muted/60"
            />
            <div className="px-2 pt-1.5 pb-1">
              <span className="mb-1 block text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Cabinet shell
              </span>
              <SegmentedTabs<ShellMode3D>
                value={shell3d}
                onValueChange={setShellMode}
                items={[
                  { value: "solid", label: "Solid" },
                  { value: "cutaway", label: "Cutaway" },
                  { value: "xray", label: "X-ray" },
                ]}
              />
            </div>
            <div className="px-2 pt-1.5 pb-1">
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  Cable thickness
                </span>
                <span className="num text-[11px] text-muted-foreground">
                  {cableScale === 1 ? "life size" : `×${cableScale}`}
                </span>
              </div>
              <Slider
                min={CABLE_SCALE_MIN}
                max={CABLE_SCALE_MAX}
                step={0.25}
                value={[cableScale]}
                onValueChange={(v) => setCableScale(v[0])}
              />
              <SegmentedTabs<CableLook>
                className="mt-2"
                value={cableLook}
                onValueChange={setCableLook}
                items={[
                  { value: "auto", label: "Auto" },
                  { value: "tubes", label: "Tubes" },
                  { value: "lines", label: "Lines" },
                ]}
              />
            </div>
            <div className="px-2 pt-1.5 pb-1">
              <span className="mb-1 block text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Quality - this device
              </span>
              <SegmentedTabs<RenderQualitySetting>
                wrap
                value={quality3d}
                onValueChange={setQuality3d}
                items={[
                  { value: "auto", label: "Auto" },
                  { value: "flat", label: "Flat" },
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Med" },
                  { value: "high", label: "High" },
                ]}
              />
              <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                Shadows and ambient occlusion. Flat turns the light rig off
                entirely. Saved per device, not on the plan - Auto probes the
                GPU.
              </p>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
