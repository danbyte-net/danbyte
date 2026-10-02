import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link, useBlocker } from "@tanstack/react-router"
import type { ShouldBlockFn } from "@tanstack/react-router"
import { ArrowDownToLine, Plus } from "lucide-react"
import { toast } from "sonner"

import { ApiError, api } from "@/lib/api"
import type { Cabinet, Device, DinRail, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { invalidateCabinetDeviceViews } from "@/lib/cabinets"
import {
  fmtGaps,
  freeGaps,
  railClash,
  railNeighbours,
} from "@/lib/din-geometry"
import { invalidateObjectQueries } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"
import type { BodyMark } from "@/components/cabinet-devices"
import { PlatePlacer, railRefusal } from "@/components/cabinet-placement"
import type { FreeSpot, PlateNote } from "@/components/cabinet-placement"
import { AssignDeviceDialog } from "@/components/cabinet-rail-actions"
import { LeaveGuardDialog } from "@/components/leave-guard-dialog"
import { PointerMenu } from "@/components/pointer-menu"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

// The cabinet page's arrange mode (#277): the devices on the plate's rails
// moved about before anything is saved - a device picked gets the outline,
// the drag, the keys and the slider the device form has; the moves wait,
// drawn where they go, red where they clash, and go to the server in one
// request it checks as a whole, so two devices can swap places.

/** Where a moved device is to go. */
interface Place {
  railId: string
  offset: number
}

/** One move as the arrange endpoint takes it. */
interface Placement {
  device_id: string
  din_rail_id: string | null
  din_offset_mm: number | null
}

/** The arrange mode's state for one cabinet: on or off, the moves waiting
 * to be saved, the device picked, what the server last refused, and the
 * save. */
export function useArrangement(
  cabinet: Cabinet | undefined,
  devices: Device[] | undefined
) {
  const qc = useQueryClient()
  const [on, setOn] = useState(false)
  const [moves, setMoves] = useState<ReadonlyMap<string, Place>>(new Map())
  const [picked, setPicked] = useState<string | null>(null)
  /** The server's refusals, by device; `detail` for the whole. */
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<string | null>(null)

  const rails = cabinet?.rails ?? []
  const railById = new Map(rails.map((r) => [r.id, r]))
  const stored = devices ?? []

  // Every device where it is to go: the moved ones at their new spot.
  const pending = stored.map((d): Device => {
    const m = moves.get(d.id)
    const r = m && railById.get(m.railId)
    return r
      ? {
          ...d,
          din_rail: { id: r.id, label: r.label, profile: r.profile },
          din_offset_mm: m.offset,
        }
      : d
  })

  // What the server would refuse there, device by device, in its words.
  const clashes: Record<string, string> = {}
  for (const d of pending) {
    const r = d.din_rail ? railById.get(d.din_rail.id) : undefined
    if (!r || d.din_offset_mm == null || !d.device_type) continue
    const why =
      railRefusal(d.device_type, r) ??
      railClash(
        d.din_offset_mm,
        d.device_type.width_mm ?? 0,
        r.length_mm,
        railNeighbours(pending, r.id, d.id)
      )
    if (why) clashes[d.id] = why
  }
  const marks: Record<string, BodyMark> = {}
  for (const d of pending) {
    if (clashes[d.id] || errors[d.id]) marks[d.id] = "clash"
    else if (moves.has(d.id)) marks[d.id] = "moved"
  }
  // Only a clash a move makes holds the save back: two devices already
  // overlapping are not this save's to fix.
  const blocked = [...moves.keys()].some((id) => !!clashes[id])

  const stop = () => {
    setOn(false)
    setMoves(new Map())
    setPicked(null)
    setErrors({})
    setDetail(null)
  }

  /** Put the device `id` at a rail and offset; back where it is stored, it
   * is no longer a move. */
  const move = (id: string, railId: string, offset: number) => {
    const d = stored.find((x) => x.id === id)
    if (!d) return
    setMoves((m) => {
      const next = new Map(m)
      if (d.din_rail?.id === railId && d.din_offset_mm === offset)
        next.delete(id)
      else next.set(id, { railId, offset })
      return next
    })
    setErrors((e) =>
      Object.fromEntries(Object.entries(e).filter(([k]) => k !== id))
    )
    setDetail(null)
  }

  const save = useMutation({
    mutationFn: (placements: Placement[]) =>
      api<{ devices: { id: string }[] }>(
        `/api/cabinets/${cabinet?.id}/arrange/`,
        { method: "POST", body: JSON.stringify({ placements }) }
      ),
    onSuccess: (_res, placements) => {
      // Draw the new places at once, ahead of the refetch.
      qc.setQueryData<Paginated<Device>>(
        ["cabinet-devices", cabinet?.id],
        (old) => (old ? { ...old, results: pending } : old)
      )
      invalidateCabinetDeviceViews(qc)
      for (const p of placements) invalidateObjectQueries(qc, p.device_id)
      void qc.invalidateQueries({ queryKey: ["devices"] })
      const n = placements.length
      toast.success(n === 1 ? "Moved 1 device" : `Moved ${n} devices`)
      stop()
    },
    onError: (err, placements) => {
      const body = err instanceof ApiError ? err.body : null
      if (err instanceof ApiError && err.status === 400 && isErrorList(body)) {
        // One entry per placement, in the order sent.
        const next: Record<string, string> = {}
        body.placements.forEach((e, i) => {
          const text = Object.values(e).flat().join(" ")
          if (text && placements[i]) next[placements[i].device_id] = text
        })
        setErrors(next)
        return
      }
      if (err instanceof ApiError && err.status === 400 && hasDetail(body)) {
        setDetail(body.detail)
        return
      }
      apiErrorToast(err)
    },
  })

  return {
    on,
    start: () => setOn(true),
    cancel: stop,
    moves,
    pending,
    marks,
    clashes,
    errors,
    detail,
    picked,
    pick: setPicked,
    move,
    blocked,
    saving: save.isPending,
    save: () =>
      save.mutate(
        [...moves].map(([id, m]) => ({
          device_id: id,
          din_rail_id: m.railId,
          din_offset_mm: m.offset,
        }))
      ),
  }
}

export type Arrangement = ReturnType<typeof useArrangement>

function isErrorList(
  body: unknown
): body is { placements: Record<string, string[]>[] } {
  return (
    !!body &&
    typeof body === "object" &&
    Array.isArray((body as { placements?: unknown }).placements) &&
    (body as { placements: unknown[] }).placements.every(
      (e) => !!e && typeof e === "object"
    )
  )
}

function hasDetail(body: unknown): body is { detail: string } {
  return (
    !!body &&
    typeof body === "object" &&
    typeof (body as { detail?: unknown }).detail === "string"
  )
}

/** The plate heading's controls while arranging: Cancel, and Save - held
 * back while nothing moved or a move clashes. */
export function ArrangeActions({
  arrangement: a,
}: {
  arrangement: Arrangement
}) {
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="-my-1 h-6 px-2 text-xs"
        disabled={a.saving}
        onClick={a.cancel}
      >
        Cancel
      </Button>
      <Button
        size="sm"
        className="-my-1 h-6 px-2 text-xs"
        disabled={a.saving || a.blocked || a.moves.size === 0}
        onClick={a.save}
      >
        {a.saving ? "Saving…" : "Save"}
      </Button>
    </>
  )
}

/** The plate while arranging: a press on a device picks it, and the picked
 * one moves as in the device form; a press on a free stretch with nothing
 * picked offers to add a device there or assign one. Leaving the page with
 * moves unsaved asks first. */
export function ArrangePlate({
  cabinet,
  arrangement: a,
}: {
  cabinet: Cabinet
  arrangement: Arrangement
}) {
  const { canDo } = useMe()
  const [menu, setMenu] = useState<FreeSpot | null>(null)
  const [assign, setAssign] = useState<{
    rail: DinRail
    offset: number
  } | null>(null)

  const picked = a.pending.find((d) => d.id === a.picked) ?? null
  const rail = picked?.din_rail
    ? cabinet.rails.find((r) => r.id === picked.din_rail?.id)
    : undefined
  const near = (railId: string) => railNeighbours(a.pending, railId, a.picked)
  const spot =
    rail && picked?.din_offset_mm != null
      ? { rail, offset: picked.din_offset_mm }
      : null

  // The line: the picked device's trouble or its rail's free room; with
  // nothing picked, the first trouble anywhere.
  const named = (id: string, text: string) => {
    const d = a.pending.find((x) => x.id === id)
    return d ? `${d.name}: ${text}` : text
  }
  let standing: PlateNote | null = null
  if (picked) {
    const why = a.errors[picked.id] ?? a.clashes[picked.id]
    if (why) standing = { text: why, bad: true }
    else if (rail) {
      const gaps = freeGaps(
        rail.length_mm,
        near(rail.id).map((n) => n.span)
      )
      standing = { text: gaps.length ? `Free ${fmtGaps(gaps)}` : "Rail full" }
    }
  } else {
    const moved = [...a.moves.keys()].find((id) => a.clashes[id])
    const failed = Object.keys(a.errors)[0]
    if (a.detail) standing = { text: a.detail, bad: true }
    else if (failed)
      standing = { text: named(failed, a.errors[failed]), bad: true }
    else if (moved)
      standing = { text: named(moved, a.clashes[moved]), bad: true }
  }

  const dirty = a.moves.size > 0
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const shouldBlock = useCallback<ShouldBlockFn>(
    ({ current, next }) =>
      dirtyRef.current && next.pathname !== current.pathname,
    []
  )
  const leave = useBlocker({
    shouldBlockFn: shouldBlock,
    enableBeforeUnload: false,
    withResolver: true,
  })
  useEffect(() => {
    if (!dirty) return
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [dirty])

  return (
    <>
      <PlatePlacer
        cabinet={cabinet}
        bodies={a.pending}
        marks={a.marks}
        subject={
          picked
            ? {
                id: picked.id,
                type: picked.device_type ?? undefined,
                name: picked.name,
                spot,
              }
            : null
        }
        near={near}
        standing={standing}
        box
        onPlace={(railId, offset) => {
          if (a.picked && offset != null) a.move(a.picked, railId, offset)
        }}
        onBody={a.pick}
        onFree={setMenu}
      />
      <PointerMenu menu={menu} onClose={() => setMenu(null)} label="Rail">
        {(m) => (
          <>
            {canDo("device", "add") && (
              <DropdownMenuItem asChild>
                <Link
                  to="/devices/new"
                  search={{
                    cabinet: cabinet.id,
                    din_rail: m.rail.id,
                    din_offset: m.offset,
                    site: cabinet.site.id,
                  }}
                >
                  <Plus /> Add device here
                </Link>
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => setAssign({ rail: m.rail, offset: m.offset })}
            >
              <ArrowDownToLine /> Assign here
            </DropdownMenuItem>
          </>
        )}
      </PointerMenu>
      <AssignDeviceDialog
        // A fresh pick per spot.
        key={assign ? `${assign.rail.id}:${assign.offset}` : "none"}
        cabinet={cabinet}
        rail={assign?.rail ?? null}
        offset={assign?.offset}
        devices={a.pending}
        onClose={() => setAssign(null)}
      />
      <LeaveGuardDialog
        blocker={leave}
        description="This cabinet has moves that are not saved."
      />
    </>
  )
}
