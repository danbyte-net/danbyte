import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  BringToFront,
  DoorOpen,
  Image as ImageIcon,
  Lock,
  LockOpen,
  SendToBack,
  Square,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanConflict,
  FloorPlanRoomMismatch,
  FloorPlanRoomRef,
  FloorPlanTile,
  RoomOption,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { scopeKey, scopeRoomsUrl } from "@/lib/floor-plan-scope"
import { apiErrorToast } from "@/lib/api-toast"
import { ColorBadge } from "@/components/cells/color-badge"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { BarIconButton } from "@/components/map-toolbar"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

import { tileName } from "./canvas-geometry"
import { roomAreaAt } from "./placement"
import type { AreaShape, PlanShape } from "./shapes"
import { floorPlanContentsKey } from "./use-floor-plan-data"

/** Where each kind of object is written. */
const ENDPOINT: Partial<Record<string, string>> = {
  device: "/api/devices/",
  rack: "/api/racks/",
  cabinet: "/api/cabinets/",
}

export type RoomPromptState = {
  room: FloorPlanRoomRef
  objects: { kind: string; id: string; name: string }[]
}

/**
 * Set the room of placed objects - one write per object through its own
 * endpoint, so each is checked against the user's change grant and lands in
 * the object's change log. Never called without a click.
 */
export function useSetRooms(planId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ room, objects }: RoomPromptState) => {
      for (const o of objects) {
        const base = ENDPOINT[o.kind]
        if (!base) continue
        await api(`${base}${o.id}/`, {
          method: "PATCH",
          body: JSON.stringify({ room_id: room.id }),
        })
      }
    },
    onSuccess: (_d, { room, objects }) => {
      toast.success(
        objects.length === 1
          ? `${objects[0].name} is in ${room.name}`
          : `${objects.length} objects are in ${room.name}`
      )
      qc.invalidateQueries({ queryKey: ["floor-plan-placeable", planId] })
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(planId) })
      qc.invalidateQueries({ queryKey: ["floor-plan-assign-rooms", planId] })
    },
    onError: (err) => apiErrorToast(err),
  })
}

/** "Set room to X?" over the plan after a drop into another room's area:
 * one click, or dismissed. Nothing changes until it is clicked. */
export function RoomPrompt({
  prompt,
  busy,
  onSet,
  onDismiss,
}: {
  prompt: RoomPromptState
  busy: boolean
  onSet: () => void
  onDismiss: () => void
}) {
  const n = prompt.objects.length
  return (
    <div
      role="status"
      data-part="room-prompt"
      className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-md"
    >
      <span className="whitespace-nowrap">
        {n === 1 ? prompt.objects[0].name : `${n} objects`}: set room to
      </span>
      <ColorBadge name={prompt.room.name} color={prompt.room.color} />
      <Button size="sm" className="h-7" disabled={busy} onClick={onSet}>
        {busy ? "Setting…" : "Set room"}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  )
}

/** **Assign rooms from areas…**: the placed objects standing in another
 * room's area, ticked ones set together. */
export function AssignRoomsDialog({
  planId,
  open,
  onOpenChange,
}: {
  planId: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ["floor-plan-assign-rooms", planId],
    queryFn: () =>
      api<{ objects: FloorPlanRoomMismatch[] }>(
        `/api/floor-plans/${planId}/assign-rooms/`,
        { method: "POST", body: JSON.stringify({ dry_run: true }) }
      ),
    enabled: open,
  })
  const rows = query.data?.objects ?? []
  const [picked, setPicked] = useState<Set<string>>(new Set())
  useEffect(() => {
    setPicked(new Set(rows.filter((r) => r.can_change).map((r) => r.id)))
  }, [query.data])
  const apply = useMutation({
    mutationFn: () =>
      api<{
        applied: unknown[]
        skipped: { reason: string }[]
      }>(`/api/floor-plans/${planId}/assign-rooms/`, {
        method: "POST",
        body: JSON.stringify({
          apply: rows
            .filter((r) => picked.has(r.id))
            .map((r) => ({ kind: r.kind, id: r.id })),
        }),
      }),
    onSuccess: (res) => {
      toast.success(
        `${res.applied.length} assigned` +
          (res.skipped.length ? `, ${res.skipped.length} skipped` : "")
      )
      qc.invalidateQueries({ queryKey: ["floor-plan-assign-rooms", planId] })
      qc.invalidateQueries({ queryKey: ["floor-plan-placeable", planId] })
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(planId) })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Assign rooms from areas</DialogTitle>
        </DialogHeader>
        {query.isLoading && <Loading />}
        {query.isError && <QueryError error={query.error} />}
        {query.isSuccess && rows.length === 0 && (
          <EmptyState title="Every placed object is in its area's room" />
        )}
        {rows.length > 0 && (
          <div className="max-h-80 overflow-y-auto" role="list">
            {rows.map((r) => (
              <label
                key={`${r.kind}:${r.id}`}
                role="listitem"
                className="flex h-9 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
              >
                <Checkbox
                  checked={picked.has(r.id)}
                  disabled={!r.can_change}
                  onCheckedChange={(v) =>
                    setPicked((prev) => {
                      const next = new Set(prev)
                      if (v === true) next.add(r.id)
                      else next.delete(r.id)
                      return next
                    })
                  }
                  aria-label={r.name}
                />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {r.room ? (
                  <ColorBadge name={r.room.name} color={r.room.color} />
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <ColorBadge name={r.area_room.name} color={r.area_room.color} />
              </label>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!picked.size || apply.isPending}
            onClick={() => apply.mutate()}
          >
            {apply.isPending ? "Assigning…" : `Assign ${picked.size}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type Choice = "mine" | "theirs"

/** **Changed elsewhere**: a save refused because rows changed since the
 * plan was opened. Per row, keep this edit or take the row as it is now. */
export function ConflictDialog({
  conflicts,
  nameOf,
  saving,
  onResolve,
  onCancel,
}: {
  conflicts: FloorPlanConflict[] | null
  /** The name to show for a row (the local draft's, or the current one's). */
  nameOf: (c: FloorPlanConflict) => string
  saving: boolean
  onResolve: (choice: Record<string, Choice>) => void
  onCancel: () => void
}) {
  const [choice, setChoice] = useState<Record<string, Choice>>({})
  useEffect(() => setChoice({}), [conflicts])
  return (
    <Dialog open={!!conflicts} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Changed elsewhere</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
          {(conflicts ?? []).map((c) => (
            <div
              key={c.id}
              data-conflict={c.id}
              className="flex items-center gap-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate">{nameOf(c)}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {c.current ? "Changed" : "Deleted"}
                  {c.changed_by ? ` by ${c.changed_by}` : ""}
                </div>
              </div>
              <SegmentedTabs<Choice>
                value={choice[c.id] ?? "mine"}
                onValueChange={(v) => setChoice((p) => ({ ...p, [c.id]: v }))}
                items={[
                  { value: "mine", label: "Keep mine" },
                  { value: "theirs", label: "Take theirs" },
                ]}
              />
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => onResolve(choice)}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The room an area can link to, picked from the floating toolbar. */
function AreaRoomButton({
  plan,
  area,
  onChange,
}: {
  plan: FloorPlan
  area: AreaShape
  onChange: (patch: Partial<PlanShape>) => void
}) {
  const [open, setOpen] = useState(false)
  const rooms = useQuery({
    queryKey: ["rooms-picker", scopeKey(plan), "descendants"],
    queryFn: () => apiAll<RoomOption>(scopeRoomsUrl(plan)),
    staleTime: 5 * 60_000,
    enabled: open,
  })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <BarIconButton label="Link room">
          <DoorOpen />
        </BarIconButton>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-2">
        <Combobox
          value={area.room?.id ?? null}
          onChange={(id) => {
            const r = rooms.data?.results.find((x) => x.id === id)
            onChange({
              room: r
                ? { id: r.id, name: r.name, code: r.code, color: r.color }
                : null,
              location: null,
            })
            setOpen(false)
          }}
          options={(rooms.data?.results ?? []).map((r) => ({
            value: r.id,
            label: r.name,
            color: r.color || null,
            badge: true,
          }))}
          placeholder="Select a room…"
          searchPlaceholder="Search rooms…"
          emptyText="No rooms in this location."
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The small toolbar floating above the selection, next to the inspector:
 * lock, link a room, photo or icon, bring forward / send back, delete. A
 * placed object standing in another room's area offers to set its room.
 */
export function SelectionToolbar({
  plan,
  tile,
  shape,
  shapes,
  onTileDisplay,
  onRestackTile,
  onDeleteTile,
  onSetRoom,
  onChangeShape,
  onRestackShape,
  onDeleteShape,
}: {
  plan: FloorPlan
  tile: FloorPlanTile | null
  shape: PlanShape | null
  shapes: PlanShape[]
  onTileDisplay: (tile: FloorPlanTile, display: "icon" | "photo") => void
  onRestackTile: (id: string, dir: 1 | -1) => void
  onDeleteTile: (id: string) => void
  onSetRoom: (prompt: RoomPromptState) => void
  onChangeShape: (id: string, patch: Partial<PlanShape>) => void
  onRestackShape: (id: string, dir: 1 | -1) => void
  onDeleteShape: (id: string) => void
}) {
  const free = plan.layout_mode === "free"
  if (tile) {
    const l = tile.linked
    const area =
      l && (l.kind === "device" || l.kind === "rack" || l.kind === "cabinet")
        ? roomAreaAt(shapes, [
            tile.x + tile.width / 2,
            tile.y + tile.height / 2,
          ])
        : null
    // The room drawn where the tile stands, when the object names another.
    const target = area?.room && l?.room?.id !== area.room.id ? area.room : null
    return (
      <div
        role="toolbar"
        aria-label={tileName(tile) || "Tile"}
        className="flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
      >
        {target && l && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 text-xs"
            onClick={() =>
              onSetRoom({
                room: target,
                objects: [{ kind: l.kind, id: l.id, name: l.name }],
              })
            }
          >
            Set room
            <ColorBadge name={target.name} color={target.color} />
          </Button>
        )}
        {tile.photo &&
          (tile.display === "photo" ? (
            <BarIconButton
              label="Show as tile"
              tipSide="top"
              onClick={() => onTileDisplay(tile, "icon")}
            >
              <Square />
            </BarIconButton>
          ) : (
            <BarIconButton
              label="Show as photo"
              tipSide="top"
              onClick={() => onTileDisplay(tile, "photo")}
            >
              <ImageIcon />
            </BarIconButton>
          ))}
        {free && (
          <>
            <BarIconButton
              label="Bring forward"
              tipSide="top"
              onClick={() => onRestackTile(tile.id, 1)}
            >
              <BringToFront />
            </BarIconButton>
            <BarIconButton
              label="Send back"
              tipSide="top"
              onClick={() => onRestackTile(tile.id, -1)}
            >
              <SendToBack />
            </BarIconButton>
          </>
        )}
        <BarIconButton
          label="Delete"
          tipSide="top"
          destructive
          onClick={() => onDeleteTile(tile.id)}
        >
          <Trash2 />
        </BarIconButton>
      </div>
    )
  }
  if (!shape) return null
  return (
    <div
      role="toolbar"
      aria-label={shape.kind === "area" ? "Area" : "Label"}
      className="flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-md"
    >
      <BarIconButton
        label={shape.locked ? "Unlock" : "Lock"}
        tipSide="top"
        onClick={() => onChangeShape(shape.id, { locked: !shape.locked })}
      >
        {shape.locked ? <LockOpen /> : <Lock />}
      </BarIconButton>
      {shape.kind === "area" && (
        <AreaRoomButton
          plan={plan}
          area={shape}
          onChange={(patch) => onChangeShape(shape.id, patch)}
        />
      )}
      <BarIconButton
        label="Bring forward"
        tipSide="top"
        onClick={() => onRestackShape(shape.id, 1)}
      >
        <BringToFront />
      </BarIconButton>
      <BarIconButton
        label="Send back"
        tipSide="top"
        onClick={() => onRestackShape(shape.id, -1)}
      >
        <SendToBack />
      </BarIconButton>
      <BarIconButton
        label="Delete"
        tipSide="top"
        destructive
        onClick={() => onDeleteShape(shape.id)}
      >
        <Trash2 />
      </BarIconButton>
    </div>
  )
}

/** An empty floor in Edit: the next things to do. */
export function PlanEmptyState({
  onDrawRoom,
  onPlace,
}: {
  onDrawRoom: () => void
  onPlace: () => void
}) {
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <EmptyState
        title="Nothing on this floor yet"
        className="pointer-events-auto bg-background/90"
      >
        <div className="mt-3 flex justify-center gap-2">
          <Button size="sm" variant="outline" onClick={onDrawRoom}>
            Draw a room
          </Button>
          <Button size="sm" onClick={onPlace}>
            Place devices
          </Button>
        </div>
      </EmptyState>
    </div>
  )
}
