import { SlidersHorizontal } from "lucide-react"

import { FormCheckbox } from "@/components/forms"
import { BarMenuTrigger } from "@/components/map-toolbar"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { PopoverField } from "../filters-popover"
import { ROUTING_FIELDS, ROUTING_LAYERS } from "./routing-model"
import type { RoutingSettings } from "./routing-model"

/** The Routing tab's Display ▾: the line layers and the card lines, each
 * an undo step saved with the view. */
export function RoutingDisplayPopover({
  settings,
  onChange,
}: {
  settings: RoutingSettings
  onChange: (next: Partial<RoutingSettings>) => void
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
