import type { FloorPlanFloor } from "@/lib/api"
import { BarMenuTrigger } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** Past this many floors the tabs become a dropdown. */
export const FLOOR_TABS_MAX = 6

/** The floors of a floor plan in order, lowest first: segmented tabs, or a
 * compact "Floor: 2" dropdown for a tall building. */
export function FloorSwitcher({
  floors,
  value,
  onChange,
}: {
  floors: FloorPlanFloor[]
  value: string
  onChange: (id: string) => void
}) {
  if (floors.length > FLOOR_TABS_MAX) {
    const current = floors.find((f) => f.id === value)
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <BarMenuTrigger aria-label="Floor">
            Floor: {current?.name ?? "…"}
          </BarMenuTrigger>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
          <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
            {/* Highest floor at the top, as a building reads. */}
            {[...floors].reverse().map((f) => (
              <DropdownMenuRadioItem key={f.id} value={f.id}>
                {f.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  return (
    <SegmentedTabs
      value={value}
      onValueChange={onChange}
      items={floors.map((f) => ({ value: f.id, label: f.name }))}
    />
  )
}
