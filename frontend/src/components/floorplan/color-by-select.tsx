import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { COLOR_BY_LABEL, readColorBy } from "./tile-paint"
import type { ColorBy } from "./tile-paint"

/** The choices in groups: the plan's own look, how full a rack is, and the
 * rack's catalog colours. */
const GROUPS: ColorBy[][] = [
  ["type"],
  ["space", "power", "ports", "panel_ports"],
  ["role", "status"],
]

/** The floor plan Display popover's **Color by** (#247): what rack tiles,
 * in 2D and in the 3D room, are coloured by. */
export function ColorBySelect({
  value,
  onChange,
}: {
  value: ColorBy
  onChange: (value: ColorBy) => void
}) {
  return (
    <div className="px-2 pt-1 pb-1.5">
      <span className="mb-1 block text-[10px] font-medium tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase">
        Color by
      </span>
      <Select value={value} onValueChange={(v) => onChange(readColorBy(v))}>
        <SelectTrigger
          size="sm"
          className="w-full text-xs"
          aria-label="Color by"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUPS.map((group, i) => (
            <SelectGroup key={group[0]}>
              {i > 0 && <SelectSeparator />}
              {group.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">
                  {COLOR_BY_LABEL[c]}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
