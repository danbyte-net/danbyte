import { SlidersHorizontal } from "lucide-react"

import { FormCheckbox } from "@/components/forms"
import { BarMenuTrigger } from "@/components/map-toolbar"
import { SectionLabel } from "@/components/map-panel"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { LINE_COLOR_BY } from "@/components/site-map/line-style"
import type { LineColorBy } from "@/components/site-map/line-style"

/** The site map's layer toggles, remembered per browser (`site-map:layers`). */
export interface SiteMapLayers {
  sites: boolean
  devices: boolean
  links: boolean
  /** Plain cables. Off = only circuits and tunnels draw between sites. */
  cables: boolean
  routes: boolean
  regions: boolean
}

const ROW =
  "items-center rounded px-2 py-1.5 text-[13px] whitespace-nowrap hover:bg-muted/60"

/**
 * The header's Display menu: what the map draws (Layers), the text on it
 * (Labels) and what its lines' colours mean (Color by).
 */
export function SiteMapDisplayMenu({
  layers,
  onLayersChange,
  stacking,
  onStackingChange,
  showFov,
  onShowFovChange,
  nameLabels,
  onNameLabelsChange,
  speedLabels,
  onSpeedLabelsChange,
  colorBy,
  onColorByChange,
}: {
  layers: SiteMapLayers
  onLayersChange: (next: SiteMapLayers) => void
  stacking: boolean
  onStackingChange: (v: boolean) => void
  showFov: boolean
  onShowFovChange: (v: boolean) => void
  nameLabels: boolean
  onNameLabelsChange: (v: boolean) => void
  speedLabels: boolean
  onSpeedLabelsChange: (v: boolean) => void
  colorBy: LineColorBy
  onColorByChange: (v: LineColorBy) => void
}) {
  const layer = (key: keyof SiteMapLayers, label: string) => (
    <FormCheckbox
      label={label}
      checked={layers[key]}
      onChange={(v) => onLayersChange({ ...layers, [key]: v })}
      className={ROW}
    />
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <SlidersHorizontal /> Display
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={12}
        className="max-h-(--radix-popover-content-available-height) w-72 gap-0 overflow-y-auto p-2"
      >
        <section aria-label="Layers" className="grid gap-0.5">
          <SectionLabel className="px-2 pt-1">Layers</SectionLabel>
          {layer("sites", "Sites")}
          {layer("devices", "Devices")}
          {layer("links", "Links (circuits · tunnels)")}
          {layer("cables", "Cables")}
          {layer("routes", "Cable routes")}
          {layer("regions", "Region boundaries")}
          <FormCheckbox
            label="Camera FOV cones"
            checked={showFov}
            onChange={onShowFovChange}
            className={ROW}
          />
          <FormCheckbox
            label="Stack nearby markers"
            checked={stacking}
            onChange={onStackingChange}
            className={ROW}
          />
        </section>
        <section
          aria-label="Labels"
          className="mt-1.5 grid gap-0.5 border-t border-border pt-2"
        >
          <SectionLabel className="px-2">Labels</SectionLabel>
          <FormCheckbox
            label="Names"
            info="On: name chips appear as you zoom in. Off: names only on hover or selection."
            checked={nameLabels}
            onChange={onNameLabelsChange}
            className={ROW}
          />
          <FormCheckbox
            label="Speed"
            info="Each line's speed, once the line is long enough on screen to carry it."
            checked={speedLabels}
            onChange={onSpeedLabelsChange}
            className={ROW}
          />
        </section>
        <section
          aria-label="Color by"
          className="mt-1.5 grid gap-1 border-t border-border px-2 pt-2 pb-1"
        >
          <SectionLabel>Color by</SectionLabel>
          <SegmentedTabs<LineColorBy>
            value={colorBy}
            onValueChange={onColorByChange}
            items={LINE_COLOR_BY}
          />
        </section>
      </PopoverContent>
    </Popover>
  )
}
