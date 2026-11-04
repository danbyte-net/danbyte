import { SlidersHorizontal } from "lucide-react"

import type { RoutingRef, RoutingVrf } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { FormCheckbox } from "@/components/forms"
import { BarMenuTrigger } from "@/components/map-toolbar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PopoverField } from "../filters-popover"
import { ROUTING_FIELDS, ROUTING_LAYERS } from "./routing-model"
import type { RoutingSettings } from "./routing-model"

/** The tables the VRF picker offers: every one (the default), Global,
 * then the map's VRFs - the one picked kept while the map has no line in
 * it. */
export function vrfOptions(
  vrfs: readonly (RoutingRef & { color?: string | null })[],
  picked: RoutingVrf
): { value: RoutingVrf; name: string; color?: string | null }[] {
  const out: { value: RoutingVrf; name: string; color?: string | null }[] = [
    { value: "all", name: "All tables" },
    { value: "global", name: "Global" },
    ...vrfs.map((v) => ({ value: v.id, name: v.name, color: v.color })),
  ]
  if (!out.some((o) => o.value === picked))
    out.push({ value: picked, name: "Other VRF" })
  return out
}

/** The Routing tab's Display ▾: the table drawn, the line layers, the
 * Checks chip and the card lines, each an undo step saved with the view. */
export function RoutingDisplayPopover({
  settings,
  onChange,
  vrfs,
  vrf,
  onVrf,
}: {
  settings: RoutingSettings
  onChange: (next: Partial<RoutingSettings>) => void
  /** The VRFs on the map (its `meta.vrfs`). */
  vrfs: readonly (RoutingRef & { color?: string | null })[]
  /** The table drawn (the URL's, over the view's). */
  vrf: RoutingVrf
  onVrf: (vrf: RoutingVrf) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <BarMenuTrigger>
          <SlidersHorizontal /> Display
        </BarMenuTrigger>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-(--radix-popover-content-available-height) w-64 space-y-3 overflow-y-auto p-3"
      >
        <PopoverField label="VRF">
          <Select value={vrf} onValueChange={(v) => onVrf(v)}>
            <SelectTrigger size="sm" className="w-full" aria-label="VRF">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {vrfOptions(vrfs, vrf).map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.color !== undefined ? (
                    <ColorBadge name={o.name} color={o.color || undefined} />
                  ) : (
                    o.name
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </PopoverField>
        <div className="border-t border-border pt-3">
          <PopoverField label="Layers" group>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ROUTING_LAYERS.map((l) => (
                <FormCheckbox
                  key={l.key}
                  label={l.label}
                  checked={settings.layers[l.key]}
                  onChange={(v) =>
                    onChange({ layers: { ...settings.layers, [l.key]: v } })
                  }
                  className="items-center whitespace-nowrap"
                />
              ))}
            </div>
          </PopoverField>
        </div>
        <div className="border-t border-border pt-3">
          <FormCheckbox
            label="Checks"
            checked={settings.checks}
            onChange={(v) => onChange({ checks: v })}
            className="items-center whitespace-nowrap"
          />
        </div>
        <div className="border-t border-border pt-3">
          <PopoverField label="Card lines" group>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {ROUTING_FIELDS.map((f) => (
                <FormCheckbox
                  key={f.key}
                  label={f.label}
                  checked={settings.fields.includes(f.key)}
                  onChange={(v) =>
                    onChange({
                      fields: ROUTING_FIELDS.map((x) => x.key).filter((k) =>
                        k === f.key ? v : settings.fields.includes(k)
                      ),
                    })
                  }
                  className="items-center whitespace-nowrap"
                />
              ))}
            </div>
          </PopoverField>
        </div>
      </PopoverContent>
    </Popover>
  )
}
