import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Bookmark, BookmarkCheck, PlugZap } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { PortReservationMini } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/forms"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** "Reserved" chip with the hold's who/why on hover - the shared tooltip,
 * never the browser-default title. Used by port rows and detail heroes. */
export function ReservedBadge({
  reservation,
}: {
  reservation: PortReservationMini
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning">Reserved</Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        {reservation.claimed_by
          ? `Reserved by ${reservation.claimed_by}`
          : "Reserved"}
        {reservation.note ? ` - ${reservation.note}` : ""}
      </TooltipContent>
    </Tooltip>
  )
}

/** Chip for mark_connected ports. Reads "Connected" - the flag means a
 * cable IS in the port - with the not-documented nuance on hover; the
 * utilization card's Undocumented count keeps carrying the doc-debt angle. */
export function UndocumentedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline">Connected</Badge>
      </TooltipTrigger>
      <TooltipContent variant="panel">
        A cable is in the port, just not documented yet
      </TooltipContent>
    </Tooltip>
  )
}

/** Align a port's reservation with an edit form's Reserved checkbox + note.
 * Called after the port itself saved; a no-op when nothing changed. */
export async function syncPortReservation(opts: {
  kind: string
  portId: string
  existing: PortReservationMini | null
  reserved: boolean
  note: string
}) {
  const { kind, portId, existing, reserved, note } = opts
  if (reserved && !existing) {
    await api("/api/port-reservations/", {
      method: "POST",
      body: JSON.stringify({ kind, port_id: portId, note }),
    })
  } else if (!reserved && existing) {
    await api(`/api/port-reservations/${existing.id}/`, { method: "DELETE" })
  } else if (reserved && existing && note !== existing.note) {
    await api(`/api/port-reservations/${existing.id}/`, {
      method: "PATCH",
      body: JSON.stringify({ note }),
    })
  }
}

/** The port a reservation targets - the cable-termination kind vocabulary. */
export interface ReservationTarget {
  kind: string
  id: string
  name: string
  /** Existing hold, when the port is already reserved (dialog shows Release). */
  reservation: PortReservationMini | null
}

/**
 * Self-contained row action: reserve a free port / open the hold on a
 * reserved one. Owns its dialog (same self-contained shape as
 * CableStatusControl) so every port table gets the flow without page wiring.
 * Renders nothing on cabled/marked/virtual ports - a hold makes no sense
 * there.
 */
export function PortReserveAction({
  kind,
  portId,
  name,
  reservation,
  canReserve,
}: {
  kind: string
  portId: string
  name: string
  reservation: PortReservationMini | null
  canReserve: boolean
}) {
  const [open, setOpen] = useState(false)
  if (!canReserve && !reservation) return null
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className={
          reservation
            ? "h-7 text-amber-500 hover:text-amber-400"
            : "h-7 text-muted-foreground hover:text-primary"
        }
        title={
          reservation
            ? `Reserved${reservation.claimed_by ? ` by ${reservation.claimed_by}` : ""}${
                reservation.note ? ` - ${reservation.note}` : ""
              }`
            : "Reserve port"
        }
        aria-label={reservation ? `Reservation on ${name}` : `Reserve ${name}`}
        onClick={() => setOpen(true)}
      >
        {reservation ? (
          <BookmarkCheck className="h-3.5 w-3.5" />
        ) : (
          <Bookmark className="h-3.5 w-3.5" />
        )}
      </Button>
      <PortReservationDialog
        target={open ? { kind, id: portId, name, reservation } : null}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

/**
 * Self-contained "mark connected" toggle for uncabled ports: one click
 * records "there IS a cable here, it just isn't documented yet"; one click
 * clears it. `endpoint` is the port's own API base (interfaces /
 * front-ports / rear-ports - the kinds that carry the flag).
 */
export function MarkConnectedToggle({
  endpoint,
  portId,
  name,
  marked,
  canEdit,
}: {
  endpoint: string
  portId: string
  name: string
  marked: boolean
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const toggle = useMutation({
    mutationFn: () =>
      api(`${endpoint}${portId}/`, {
        method: "PATCH",
        body: JSON.stringify({ mark_connected: !marked }),
      }),
    onSuccess: () => {
      toast.success(marked ? "Mark cleared" : "Marked connected")
      qc.invalidateQueries()
    },
    onError: (e) => apiErrorToast(e, "Could not update the port"),
  })
  if (!canEdit) return null
  return (
    <Button
      size="sm"
      variant="ghost"
      className={
        marked
          ? "h-7 text-emerald-500 hover:text-emerald-400"
          : "h-7 text-muted-foreground hover:text-primary"
      }
      title={
        marked
          ? "Marked connected (cable undocumented) - click to clear"
          : "Mark connected - a cable is in the port, just not documented yet"
      }
      aria-label={`Mark ${name} connected`}
      disabled={toggle.isPending}
      onClick={() => toggle.mutate()}
    >
      <PlugZap className="h-3.5 w-3.5" />
    </Button>
  )
}

/**
 * Reserve / release a single uncabled port. The hold needs no far end - it
 * complements planned cables for the "I'll need this port, cable TBD" case.
 * Auto-released server-side when a real cable lands on the port.
 */
export function PortReservationDialog({
  target,
  onClose,
}: {
  target: ReservationTarget | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [note, setNote] = useState("")

  useEffect(() => {
    setNote(target?.reservation?.note ?? "")
  }, [target])

  const done = (msg: string) => {
    toast.success(msg)
    qc.invalidateQueries()
    onClose()
  }

  const reserve = useMutation({
    mutationFn: () => {
      if (!target) throw new Error("No port selected")
      return api("/api/port-reservations/", {
        method: "POST",
        body: JSON.stringify({
          kind: target.kind,
          port_id: target.id,
          note,
        }),
      })
    },
    onSuccess: () => done("Port reserved"),
    onError: (e) => apiErrorToast(e, "Could not reserve the port"),
  })

  const release = useMutation({
    mutationFn: () => {
      if (!target?.reservation) throw new Error("No reservation")
      return api(`/api/port-reservations/${target.reservation.id}/`, {
        method: "DELETE",
      })
    },
    onSuccess: () => done("Reservation released"),
    onError: (e) => apiErrorToast(e, "Could not release the reservation"),
  })

  const rename = useMutation({
    mutationFn: () => {
      if (!target?.reservation) throw new Error("No reservation")
      return api(`/api/port-reservations/${target.reservation.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ note }),
      })
    },
    onSuccess: () => done("Note saved"),
    onError: (e) => apiErrorToast(e, "Could not save the note"),
  })

  const existing = target?.reservation ?? null

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing ? "Reserved port" : "Reserve port"}
          </DialogTitle>
          <DialogDescription>
            {existing
              ? `${target?.name} is held${
                  existing.claimed_by ? ` by ${existing.claimed_by}` : ""
                }. Connecting a cable releases the hold automatically.`
              : `Hold ${target?.name} without picking the far end yet. The hold releases automatically when a cable lands.`}
          </DialogDescription>
        </DialogHeader>

        <Field label="Note">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Who or what this port is for"
            maxLength={200}
          />
        </Field>
        {existing && (
          <div className="text-sm text-muted-foreground">
            Reserved <TimeCell iso={existing.created_at} />
            {existing.claimed_by ? ` by ${existing.claimed_by}` : ""}
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {existing ? (
            <>
              <Button
                size="sm"
                variant="destructive"
                disabled={release.isPending}
                onClick={() => release.mutate()}
              >
                {release.isPending ? "Releasing…" : "Release"}
              </Button>
              <Button
                size="sm"
                disabled={rename.isPending || note === existing.note}
                onClick={() => rename.mutate()}
              >
                {rename.isPending ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={reserve.isPending}
              onClick={() => reserve.mutate()}
            >
              {reserve.isPending ? "Reserving…" : "Reserve"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
