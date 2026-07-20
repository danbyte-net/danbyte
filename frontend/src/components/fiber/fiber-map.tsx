import { useState } from "react"
import { Waypoints } from "lucide-react"

import { fiberColor, TIA_598C } from "@/lib/fiber"
import type { FiberColorEntry } from "@/lib/fiber"
import { Input } from "@/components/ui/input"
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
import { Button } from "@/components/ui/button"
import { FiberDot } from "./fiber-dot"

export type StrandAnno = { label?: string; status?: string }
export type Strands = Record<string, StrandAnno>

const STATUS_OPTS = [
  { value: "in-use", label: "In use" },
  { value: "spare", label: "Spare" },
  { value: "reserved", label: "Reserved" },
  { value: "dark", label: "Dark" },
  { value: "damaged", label: "Damaged" },
]

/** The strand grid for a fibre cable. Strands are grouped into 12-fibre
 * **units** (buffer tubes / ribbons): each unit is a labelled block laid out on
 * an aligned grid, so a big count stays calm and readable. When `editable`,
 * clicking a strand labels it + sets a status. */
export function FiberMap({
  count,
  strands,
  palette,
  editable = false,
  onChange,
  onTrace,
  highlight,
  onHighlight,
}: {
  count: number
  strands: Strands
  palette: FiberColorEntry[]
  editable?: boolean
  onChange?: (position: number, anno: StrandAnno) => void
  /** Trace this strand end-to-end through the panels. */
  onTrace?: (position: number) => void
  highlight?: number | null
  onHighlight?: (position: number | null) => void
}) {
  // Fall back to the standard palette when none is supplied (or during the
  // first paint of the settings page, before local state is populated) — an
  // empty palette made `tube` below undefined and crashed on `tube.hex`.
  const pal = palette.length ? palette : TIA_598C
  const per = pal.length
  const units = Math.ceil(count / per)
  const multi = units > 1

  return (
    <div className="max-w-lg space-y-4">
      {Array.from({ length: units }, (_, u) => {
        const start = u * per
        const tube = pal[u % pal.length]
        const cells = Array.from(
          { length: Math.min(per, count - start) },
          (__, i) => start + i + 1
        )
        return (
          <div key={u}>
            {multi && (
              <div className="mb-2 flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-full ring-1 ring-border ring-inset"
                  style={{ backgroundColor: tube.hex }}
                />
                <span className="text-[11px] font-medium tracking-[0.06em] text-muted-foreground uppercase">
                  Unit {u + 1} · {tube.name}
                </span>
              </div>
            )}
            <div className="grid grid-cols-6 gap-x-1 gap-y-3 sm:grid-cols-12">
              {cells.map((pos) => (
                <StrandCell
                  key={pos}
                  pos={pos}
                  palette={pal}
                  anno={strands[String(pos)]}
                  editable={editable}
                  highlighted={highlight === pos}
                  onSave={(a) => onChange?.(pos, a)}
                  onTrace={onTrace}
                  onHover={onHighlight}
                />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function StrandCell({
  pos,
  palette,
  anno,
  editable,
  highlighted,
  onSave,
  onTrace,
  onHover,
}: {
  pos: number
  palette: FiberColorEntry[]
  anno?: StrandAnno
  editable: boolean
  highlighted: boolean
  onSave: (a: StrandAnno) => void
  onTrace?: (position: number) => void
  onHover?: (position: number | null) => void
}) {
  const c = fiberColor(pos, palette)
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState(anno?.label ?? "")
  const [status, setStatus] = useState(anno?.status ?? "")
  const labelled = !!anno?.label
  const dim = anno?.status === "damaged" || anno?.status === "dark"
  const tip =
    `Fibre ${pos} · ${c.name}` +
    (anno?.label ? ` · ${anno.label}` : "") +
    (anno?.status ? ` · ${anno.status}` : "")

  const cell = (
    <button
      type="button"
      className={
        "flex flex-col items-center gap-1 rounded-md py-1 transition-colors " +
        (highlighted ? "bg-primary/10 ring-1 ring-primary" : "") +
        (editable ? " hover:bg-muted/60" : "") +
        (dim ? " opacity-45" : "")
      }
      onMouseEnter={() => onHover?.(pos)}
      onMouseLeave={() => onHover?.(null)}
      onClick={
        editable
          ? () => setOpen(true)
          : onTrace
            ? () => onTrace(pos)
            : undefined
      }
      title={tip}
    >
      <FiberDot position={pos} palette={palette} size={20} showTracer />
      <span
        className={
          "num text-[10px] leading-none " +
          (labelled ? "font-semibold text-foreground" : "text-muted-foreground")
        }
      >
        {pos}
      </span>
    </button>
  )

  if (!editable) return cell

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{cell}</PopoverTrigger>
      <PopoverContent align="center" className="w-56 space-y-2 p-3">
        <div className="flex items-center gap-2 text-xs font-medium">
          <FiberDot position={pos} palette={palette} size={14} showTracer />
          Fibre {pos} · {c.name}
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Label</span>
          <Input
            autoFocus
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Cust-A pri"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <span className="text-[11px] text-muted-foreground">Status</span>
          <Select
            value={status || "none"}
            onValueChange={(v) => setStatus(v === "none" ? "" : v)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">—</SelectItem>
              {STATUS_OPTS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pt-1">
          {onTrace && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={() => {
                setOpen(false)
                onTrace(pos)
              }}
            >
              <Waypoints className="h-3.5 w-3.5" /> Trace
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                setLabel("")
                setStatus("")
                onSave({})
                setOpen(false)
              }}
            >
              Clear
            </Button>
            <Button
              size="sm"
              className="h-7 text-xs"
              onClick={() => {
                onSave({
                  ...(label.trim() ? { label: label.trim() } : {}),
                  ...(status ? { status } : {}),
                })
                setOpen(false)
              }}
            >
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
