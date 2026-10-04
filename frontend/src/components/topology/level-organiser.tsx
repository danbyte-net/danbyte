import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { GripVertical, Link2, Unlink } from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { Button } from "@/components/ui/button"
import { InfoTip } from "@/components/ui/info-tip"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { resolveLevels } from "./levels-param"

/** A device role present on the map, with its color for its badge. */
export interface RoleTier {
  name: string
  color?: string
}

export { resolveLevels }

/** What the levels popover edits: the roles on the map and their order,
 * bonds and gaps. */
export interface LevelsProps {
  roles: RoleTier[]
  /** Current role order (names); may include roles no longer on the map. */
  order: string[]
  onChange: (order: string[]) => void
  /** Roles that share the level of the role above them. */
  bonds: string[]
  onBonds: (bonds: string[]) => void
  /** Role name → distance step (0–4) for the gap above its level. */
  distance: Record<string, number>
  onDistance: (role: string, step: number) => void
}

/**
 * Drag device roles into the level order you want them stacked in - top of
 * the list = first level (left in Left to right, top in Top to bottom).
 * Nodes then lay out by their role's position here instead of by pure graph
 * structure. Roles left off, and devices with no role, fall to the last
 * level.
 *
 * Roles can be **bonded** to the row above with the link button between them,
 * putting both on one level - for when two roles belong side by side rather
 * than stacked.
 *
 * A popover with no trigger of its own: `children` is what it hangs from
 * (the Arrange menu's button, whose "Levels…" opens it), and the owner
 * holds `open`.
 */
export function LevelOrganiser({
  open,
  onOpenChange,
  children,
  roles,
  order,
  onChange,
  bonds,
  onBonds,
  distance,
  onDistance,
}: LevelsProps & {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The element the popover is anchored to. */
  children: React.ReactElement
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  // Present roles, in the saved order first, then any new ones appended.
  const present = roles.map((r) => r.name)
  const ordered = [
    ...order.filter((n) => present.includes(n)),
    ...present.filter((n) => !order.includes(n)),
  ]
  const colorOf = new Map(roles.map((r) => [r.name, r.color]))

  // Level number per row - bonded rows share the number of the row above.
  const levels = resolveLevels(ordered, bonds)
  const levelOf = new Map<string, number>()
  levels.forEach((group, i) => group.forEach((n) => levelOf.set(n, i + 1)))

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const from = ordered.indexOf(String(active.id))
    const to = ordered.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    const next = arrayMove(ordered, from, to)
    onChange(next)
    // The first row can't be bonded - there's nothing above it to bond to.
    if (next.length && bonds.includes(next[0]))
      onBonds(bonds.filter((b) => b !== next[0]))
  }

  const toggleBond = (name: string) =>
    onBonds(
      bonds.includes(name) ? bonds.filter((b) => b !== name) : [...bonds, name]
    )

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      {/* Long role lists must scroll inside the popover, not overflow the
          viewport - cap to the available height. */}
      <PopoverContent
        align="end"
        aria-label="Levels"
        className="flex max-h-[min(70vh,32rem)] w-64 flex-col gap-1.5 p-2"
      >
        <div className="flex shrink-0 items-center gap-1 px-1">
          <span className="text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
            Levels
          </span>
          <InfoTip>Drag to reorder. Link two rows to share a level.</InfoTip>
        </div>
        {ordered.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No roles on this map.
          </p>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={ordered}
              strategy={verticalListSortingStrategy}
            >
              <ul className="min-h-0 flex-1 overflow-y-auto pr-0.5">
                {ordered.map((name, i) => {
                  const bonded = i > 0 && bonds.includes(name)
                  return (
                    <li key={name}>
                      {/* Between-row link: bonds this row to the one above, so
                          both sit on one level. */}
                      {i > 0 && (
                        <div className="flex items-center gap-1.5 py-0.5 pl-0.5">
                          <BondButton
                            bonded={bonded}
                            tip={
                              bonded
                                ? "Own level"
                                : `Same level as ${ordered[i - 1]}`
                            }
                            onClick={() => toggleBond(name)}
                          />
                          {bonded && (
                            <span className="text-[10px] text-muted-foreground">
                              Same level
                            </span>
                          )}
                        </div>
                      )}
                      <TierRow
                        name={name}
                        level={levelOf.get(name) ?? i + 1}
                        color={colorOf.get(name)}
                        distance={distance[name] ?? 2}
                        onDistance={(step) => onDistance(name, step)}
                        // A bonded row shares the level's gap, so its own
                        // distance dots would be a lie.
                        showDistance={i > 0 && !bonded}
                        bonded={bonded}
                      />
                    </li>
                  )
                })}
              </ul>
            </SortableContext>
          </DndContext>
        )}
        {order.length > 0 && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onChange([])
              onBonds([])
            }}
            className="mt-1 shrink-0 self-start text-muted-foreground"
          >
            Reset levels
          </Button>
        )}
      </PopoverContent>
    </Popover>
  )
}

/** The link between two rows: bonds this row to the level above, or splits
 * it off again. Its tooltip says what a click does. */
function BondButton({
  bonded,
  tip,
  onClick,
}: {
  bonded: boolean
  tip: string
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant={bonded ? "default" : "outline"}
          size="icon-xs"
          onClick={onClick}
          aria-label={tip}
          aria-pressed={bonded}
          className={cn(!bonded && "text-muted-foreground")}
        >
          {bonded ? <Link2 /> : <Unlink />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right" variant="default">
        {tip}
      </TooltipContent>
    </Tooltip>
  )
}

function TierRow({
  name,
  level,
  color,
  distance,
  onDistance,
  showDistance,
  bonded,
}: {
  name: string
  /** 1-based level this role lands on - shared with the row above when
   * bonded. */
  level: number
  color?: string
  distance: number
  onDistance: (step: number) => void
  showDistance: boolean
  bonded?: boolean
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: name })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[12px]",
        isDragging && "opacity-60",
        // Bonded rows read as one block with the row above.
        bonded && "border-primary/40"
      )}
    >
      {/* No tooltip: the popover opens with the focus here, and a tip
          would pop up every time it does. */}
      <button
        type="button"
        aria-label="Reorder"
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="num w-4 text-[10px] text-muted-foreground">{level}</span>
      <span className="flex min-w-0 flex-1">
        <ColorBadge
          name={name}
          color={color || undefined}
          className="block max-w-full truncate"
        />
      </span>
      {showDistance && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex shrink-0 items-center gap-0.5">
              {[0, 1, 2, 3, 4].map((step) => (
                <button
                  key={step}
                  type="button"
                  aria-label={`Gap above ${step + 1}`}
                  onClick={() => onDistance(step)}
                  className={
                    "h-2 w-2 rounded-full transition-colors " +
                    (step <= distance
                      ? "bg-primary"
                      : "bg-muted-foreground/25 hover:bg-muted-foreground/50")
                  }
                />
              ))}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" variant="default">
            Gap above
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
