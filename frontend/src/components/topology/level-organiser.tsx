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
import { GripVertical, Layers, Link2, Unlink } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** A device role present on the map, with its color for the swatch. */
export interface RoleTier {
  name: string
  color?: string
}

/**
 * Resolve the role order + bonds into levels: `[[role, …], …]`.
 *
 * A role listed in `bonds` shares the level of the role directly above it, so
 * several roles can occupy one level (core switches beside routers, say). The
 * first role can never be bonded — there's nothing above it.
 *
 * Shared with the canvas so the popover and the layout can't disagree.
 */
export function resolveLevels(order: string[], bonds: string[]): string[][] {
  const out: string[][] = []
  order.forEach((name, i) => {
    if (i > 0 && bonds.includes(name) && out.length)
      out[out.length - 1].push(name)
    else out.push([name])
  })
  return out
}

/**
 * Drag device roles into the tier order you want them stacked in — top of the
 * list = first level (left in side-to-side, top in tree). Nodes then lay out
 * by their role's position here instead of by pure graph structure. Roles left
 * off, and devices with no role, fall to the last tier.
 *
 * Roles can be **bonded** to the row above with the link button between them,
 * putting both on one level — for when two roles belong side by side rather
 * than stacked.
 */
export function LevelOrganiser({
  roles,
  order,
  onChange,
  bonds,
  onBonds,
  distance,
  onDistance,
}: {
  roles: RoleTier[]
  /** Current role order (names); may include roles no longer on the map. */
  order: string[]
  onChange: (order: string[]) => void
  /** Roles that share the level of the role above them. */
  bonds: string[]
  onBonds: (bonds: string[]) => void
  /** Role name → distance step (0–4) for the gap above its tier. */
  distance: Record<string, number>
  onDistance: (role: string, step: number) => void
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

  // Level number per row — bonded rows share the number of the row above.
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
    // The first row can't be bonded — there's nothing above it to bond to.
    if (next.length && bonds.includes(next[0]))
      onBonds(bonds.filter((b) => b !== next[0]))
  }

  const toggleBond = (name: string) =>
    onBonds(
      bonds.includes(name) ? bonds.filter((b) => b !== name) : [...bonds, name]
    )

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          <Layers className="h-3.5 w-3.5" /> Levels
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60 p-2">
        <div className="mb-1.5 px-1 text-[11px] text-muted-foreground">
          Drag roles into tier order. Link two rows to put them on the{" "}
          <span className="font-medium">same level</span>.
        </div>
        {ordered.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No device roles on the map.
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
              <ul>
                {ordered.map((name, i) => {
                  const bonded = i > 0 && bonds.includes(name)
                  return (
                    <li key={name}>
                      {/* Between-row link: bonds this row to the one above, so
                          both sit on one level. */}
                      {i > 0 && (
                        <div className="flex items-center gap-1.5 py-0.5 pl-[7px]">
                          <button
                            type="button"
                            onClick={() => toggleBond(name)}
                            title={
                              bonded
                                ? `Split ${name} onto its own level`
                                : `Put ${name} on the same level as ${ordered[i - 1]}`
                            }
                            className={cn(
                              "flex h-4 w-4 items-center justify-center rounded-full border transition-colors",
                              bonded
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground"
                            )}
                          >
                            {bonded ? (
                              <Link2 className="h-2.5 w-2.5" />
                            ) : (
                              <Unlink className="h-2.5 w-2.5" />
                            )}
                          </button>
                          {bonded && (
                            <span className="text-[10px] text-muted-foreground">
                              same level
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
          <button
            type="button"
            onClick={() => {
              onChange([])
              onBonds([])
            }}
            className="mt-2 w-full rounded px-1 py-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
          >
            Clear — lay out by structure
          </button>
        )}
      </PopoverContent>
    </Popover>
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
  /** 1-based level this role lands on — shared with the row above when bonded. */
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
      <button
        type="button"
        className="cursor-grab text-muted-foreground active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <span className="num w-4 text-[10px] text-muted-foreground">{level}</span>
      <span
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ background: color || "var(--border)" }}
      />
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {showDistance && (
        <span
          className="flex shrink-0 items-center gap-0.5"
          title="Gap above this tier"
        >
          {[0, 1, 2, 3, 4].map((step) => (
            <button
              key={step}
              type="button"
              aria-label={`Distance ${step + 1}`}
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
      )}
    </div>
  )
}
