import type { AreaNamePosition, AreaNameStyle } from "@/lib/api"
import { Field, FormCheckbox } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ColorPicker } from "@/components/ui/color-picker"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"

import { AREA_NAME_POSITIONS, AREA_NAME_SIZES } from "./area-name-style"
import type { AreaNameLook, AreaNameSize } from "./area-name-style"

const POSITION_NAME: Record<AreaNamePosition, string> = {
  "top-left": "Top left",
  top: "Top",
  "top-right": "Top right",
  left: "Left",
  center: "Centre",
  right: "Right",
  "bottom-left": "Bottom left",
  bottom: "Bottom",
  "bottom-right": "Bottom right",
}

/** The nine places as a 3 × 3 grid of toggles, each showing where in the
 * box the name sits. */
export function NamePositionPicker({
  value,
  onChange,
}: {
  value: AreaNamePosition
  onChange: (v: AreaNamePosition) => void
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      spacing={1}
      value={value}
      // A press on the one already on clears nothing: a name always sits
      // somewhere.
      onValueChange={(v) => v && onChange(v as AreaNamePosition)}
      aria-label="Name position"
      className="grid w-fit grid-cols-3 gap-0.5"
    >
      {AREA_NAME_POSITIONS.map((p) => {
        const col = p.endsWith("left")
          ? "justify-start"
          : p.endsWith("right")
            ? "justify-end"
            : "justify-center"
        const row = p.startsWith("top")
          ? "items-start"
          : p.startsWith("bottom")
            ? "items-end"
            : "items-center"
        return (
          <ToggleGroupItem
            key={p}
            value={p}
            aria-label={POSITION_NAME[p]}
            data-position={p}
            className={cn("flex size-7 min-w-0 p-1", col, row)}
          >
            <span className="h-1 w-2.5 rounded-sm bg-current" />
          </ToggleGroupItem>
        )
      })}
    </ToggleGroup>
  )
}

/** An area name's look: position, size, colour and backplate. `look` is
 * what is drawn (the stored keys over what they inherit); a change writes
 * the stored keys. With `onReset` (an area's own override) a key can go
 * back to the plan's default. */
export function AreaNameStyleFields({
  value,
  look,
  onChange,
  onReset,
}: {
  value: AreaNameStyle
  look: AreaNameLook
  onChange: (next: AreaNameStyle) => void
  onReset?: () => void
}) {
  const set = (patch: AreaNameStyle) => onChange({ ...value, ...patch })
  return (
    <div className="flex flex-col gap-3" data-part="area-name-style">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
        <Field label="Position">
          <NamePositionPicker
            value={look.position}
            onChange={(position) => set({ position })}
          />
        </Field>
        <Field label="Size">
          <SegmentedTabs<AreaNameSize>
            label="Name size"
            value={look.size}
            onValueChange={(size) => set({ size })}
            items={AREA_NAME_SIZES.map((s) => ({
              value: s.key,
              label: s.label,
            }))}
          />
        </Field>
      </div>
      <Field
        label="Colour"
        info="Blank: Auto, the area's own colour as it reads in either theme."
      >
        <ColorPicker value={look.color} onChange={(color) => set({ color })} />
      </Field>
      <FormCheckbox
        label="Backplate"
        checked={look.plate}
        onChange={(plate) => set({ plate })}
      />
      {onReset && Object.keys(value).length > 0 && (
        <button
          type="button"
          onClick={onReset}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Use plan default
        </button>
      )}
    </div>
  )
}
