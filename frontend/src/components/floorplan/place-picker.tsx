import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Box, HardDrive, Plus, Server, X } from "lucide-react"

import { api } from "@/lib/api"
import type { FloorPlan, FloorPlanPlaceable } from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { BarMenuTrigger, BarTip } from "@/components/map-toolbar"
import { ObjectsSection } from "@/components/objects-panel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import { PLACE_MIME, placeKey, withDraftPlacement } from "./placement"
import type { NearScope } from "./placement"

const KIND_ICON = { device: HardDrive, rack: Server, cabinet: Box } as const

/** The placeable query: the picker and the unplaced list. */
export function placeableKey(planId: string, params: Record<string, string>) {
  return ["floor-plan-placeable", planId, params] as const
}

export function usePlaceable(
  planId: string,
  params: Record<string, string>,
  enabled = true
) {
  return useQuery({
    queryKey: placeableKey(planId, params),
    queryFn: () =>
      api<{ results: FloorPlanPlaceable[] }>(
        `/api/floor-plans/${planId}/placeable/?${new URLSearchParams(params)}`
      ),
    enabled,
    staleTime: 15_000,
  })
}

/** Start dragging rows onto the plan. */
export function dragRows(e: React.DragEvent, rows: FloorPlanPlaceable[]) {
  e.dataTransfer.setData(PLACE_MIME, JSON.stringify(rows))
  e.dataTransfer.effectAllowed = "copy"
}

/** Where a row is already placed, as a badge. */
export function PlacedBadge({ row }: { row: FloorPlanPlaceable }) {
  if (!row.placed_count) return null
  const here = row.placed_on.some((p) => p.this_floor)
  const other = row.placed_on.find((p) => !p.this_floor)
  return (
    <Badge variant="outline" className="shrink-0">
      {here ? "On this floor" : (other?.floor_plan.name ?? "Placed")}
    </Badge>
  )
}

/** One draggable placeable row. */
export function PlaceableRow({
  row,
  checked,
  onCheckedChange,
  onClick,
  dragging,
}: {
  row: FloorPlanPlaceable
  checked?: boolean
  onCheckedChange?: (v: boolean) => void
  onClick: () => void
  /** The rows a drag from this one carries. */
  dragging: () => FloorPlanPlaceable[]
}) {
  const Icon = KIND_ICON[row.kind]
  return (
    <div
      role="option"
      aria-selected={!!checked}
      draggable
      data-placeable={row.id}
      onDragStart={(e) => dragRows(e, dragging())}
      className="flex h-8 cursor-grab items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
    >
      {onCheckedChange && (
        <Checkbox
          checked={!!checked}
          onCheckedChange={(v) => onCheckedChange(v === true)}
          aria-label={`Select ${row.name}`}
        />
      )}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
        onClick={onClick}
      >
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{row.name}</span>
      </button>
      {row.room && <ColorBadge name={row.room.name} color={row.room.color} />}
      <PlacedBadge row={row} />
    </div>
  )
}

/** The Objects panel's **Not placed**: the floor's devices, racks and
 * cabinets placed on no plan - this floor counted as the editor holds it,
 * unsaved edits included. Drag one onto the plan, or click it. */
export function UnplacedList({
  planId,
  onFloor,
  onPlace,
}: {
  planId: string
  /** What the editor's tiles link, saved or not: `kind:id` -> tile id. */
  onFloor: Map<string, string>
  onPlace: (rows: FloorPlanPlaceable[]) => void
}) {
  const query = usePlaceable(planId, {
    unplaced: "1",
    include_here: "1",
    limit: "200",
  })
  const rows = (query.data?.results ?? []).filter(
    (r) => !onFloor.has(placeKey(r.kind, r.id))
  )
  if (!rows.length) return null
  return (
    <ObjectsSection
      heading="Not placed"
      action={<Badge variant="secondary">{rows.length}</Badge>}
    >
      <div role="listbox" aria-label="Not placed">
        {rows.map((row) => (
          <PlaceableRow
            key={`${row.kind}:${row.id}`}
            row={row}
            onClick={() => onPlace([row])}
            dragging={() => [row]}
          />
        ))}
      </div>
    </ObjectsSection>
  )
}

/**
 * **Place…**: the devices, racks and cabinets of the plan's site, those in
 * the room near the pointer first. Click a row to place it in the middle of
 * the view, drag it (or the ticked ones) onto the plan. No tile type needed:
 * a placed object draws in its own role's colour and icon.
 */
export function PlacePicker({
  plan,
  onFloor,
  open,
  onOpenChange,
  near,
  onPlace,
  onShow,
  onAssignRooms,
}: {
  plan: FloorPlan
  /** What the editor's tiles link, saved or not: `kind:id` -> tile id. */
  onFloor: Map<string, string>
  open: boolean
  onOpenChange: (v: boolean) => void
  /** The room or location near the pointer when the picker opened. */
  near: NearScope | null
  /** Place these rows in the middle of the view. */
  onPlace: (rows: FloorPlanPlaceable[]) => void
  /** Select an object already on this floor. */
  onShow: (tileId: string) => void
  onAssignRooms: () => void
}) {
  const [q, setQ] = useState("")
  const [scope, setScope] = useState<NearScope | null>(near)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  // Each opening takes the room near the pointer afresh.
  useEffect(() => {
    if (open) {
      setScope(near)
      setPicked(new Set())
    }
  }, [open])
  const params: Record<string, string> = {}
  if (q.trim()) params.q = q.trim()
  if (scope?.room) params.near_room = scope.room.id
  else if (scope?.location) params.near_location = scope.location.id
  const query = usePlaceable(plan.id, params, open)
  // "On this floor" as the editor holds it: a tile placed or deleted
  // since the last save counts at once.
  const rows = (query.data?.results ?? []).map((r) =>
    withDraftPlacement(r, onFloor, plan)
  )
  const nearName = scope?.room?.name ?? scope?.location?.name
  const groups: [string, FloorPlanPlaceable[]][] = (
    [
      [nearName ? `In ${nearName}` : "", rows.filter((r) => r.rank === 0)],
      [`In ${plan.location.name}`, rows.filter((r) => r.rank === 1)],
      ["Elsewhere", rows.filter((r) => r.rank === 2)],
    ] as [string, FloorPlanPlaceable[]][]
  ).filter(([, list]) => list.length > 0)
  const selected = rows.filter((r) => picked.has(r.id))

  const click = (row: FloorPlanPlaceable) => {
    const here = row.placed_on.find((p) => p.this_floor)
    if (here) onShow(here.tile_id)
    else onPlace([row])
    onOpenChange(false)
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <BarTip tip="Place…" shortcut="P">
        <PopoverTrigger asChild>
          <BarMenuTrigger>
            <Plus /> Place…
          </BarMenuTrigger>
        </PopoverTrigger>
      </BarTip>
      <PopoverContent
        align="start"
        className="flex w-[26rem] flex-col gap-2 p-2"
        // Rows drag onto the plan under it: keep the picker open meanwhile.
        onInteractOutside={(e) => {
          if (e.type === "dismissableLayer.focusOutside") e.preventDefault()
        }}
      >
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Find a device, rack or cabinet…"
            className="h-8"
            aria-label="Find"
          />
        </div>
        {scope && nearName && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Near
            <ColorBadge
              name={nearName}
              color={scope.room?.color ?? scope.location?.color ?? ""}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear near"
              onClick={() => setScope(null)}
            >
              <X />
            </Button>
          </div>
        )}
        <div className="max-h-80 overflow-y-auto" role="listbox">
          {query.isLoading && <Loading />}
          {query.isError && <QueryError error={query.error} />}
          {query.isSuccess && rows.length === 0 && (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              Nothing to place
            </p>
          )}
          {groups.map(([title, list]) => (
            <div key={title || "near"} data-group={title}>
              {title && (
                <div className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                  {title}
                </div>
              )}
              {list.map((row) => (
                <PlaceableRow
                  key={`${row.kind}:${row.id}`}
                  row={row}
                  checked={picked.has(row.id)}
                  onCheckedChange={(v) =>
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (v) next.add(row.id)
                      else next.delete(row.id)
                      return next
                    })
                  }
                  onClick={() => click(row)}
                  dragging={() =>
                    picked.has(row.id) && selected.length ? selected : [row]
                  }
                />
              ))}
            </div>
          ))}
        </div>
        <div
          className={cn(
            "flex items-center gap-2 border-t border-border pt-2",
            !selected.length && "justify-end"
          )}
        >
          {selected.length > 0 && (
            <Button
              size="sm"
              onClick={() => {
                onPlace(selected)
                onOpenChange(false)
              }}
            >
              Place {selected.length}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className={cn(selected.length > 0 && "ml-auto")}
            onClick={() => {
              onOpenChange(false)
              onAssignRooms()
            }}
          >
            Assign rooms from areas…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
