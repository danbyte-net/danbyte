import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Tags, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SlaCauseRow,
  SlaIncident,
  SlaIncidentCause,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  FormCheckbox,
  FormColor,
  FormStatusSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ColorBadge } from "@/components/cells/color-badge"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { fmtSpan } from "./status-strip"

const CAUSES = "/api/monitoring/sla-incident-causes/"
const FOLLOW_UPS = "/api/monitoring/sla-incident-follow-ups/"

export function useSlaCauses(enabled = true) {
  return useQuery({
    queryKey: ["sla-incident-causes"],
    queryFn: () => api<Paginated<SlaIncidentCause>>(`${CAUSES}?page_size=500`),
    enabled,
    staleTime: 60_000,
  })
}

/** Cause, ticket link, note and dispute for one incident. None of it changes
 * the figure: excluding time stays an exclusion. */
export function SlaFollowUpDialog({
  agreementId,
  incident,
  onOpenChange,
  onSaved,
}: {
  agreementId: string
  /** The incident to follow up; the dialog is open while set. */
  incident: SlaIncident | null
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  return (
    <Dialog open={!!incident} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Follow up</DialogTitle>
          {incident && (
            <DialogDescription>
              {incident.label} · {new Date(incident.start).toLocaleString()} ·{" "}
              {fmtSpan(incident.seconds * 1000)}
            </DialogDescription>
          )}
        </DialogHeader>
        {incident && (
          <FollowUpForm
            key={`${incident.unit}-${incident.start}`}
            agreementId={agreementId}
            incident={incident}
            onDone={() => onOpenChange(false)}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function FollowUpForm({
  agreementId,
  incident,
  onDone,
  onSaved,
}: {
  agreementId: string
  incident: SlaIncident
  onDone: () => void
  onSaved: () => void
}) {
  const fu = incident.follow_up
  const causes = useSlaCauses()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [cause, setCause] = useState<string | null>(fu?.cause ?? null)
  const [ticket, setTicket] = useState(fu?.ticket_url ?? "")
  const [note, setNote] = useState(fu?.note ?? "")
  const [disputed, setDisputed] = useState(fu?.disputed ?? false)
  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = {
        cause,
        ticket_url: ticket.trim(),
        note,
        disputed,
      }
      return fu
        ? api(`${FOLLOW_UPS}${fu.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api(FOLLOW_UPS, {
            method: "POST",
            body: JSON.stringify({
              ...body,
              agreement: agreementId,
              unit: incident.unit,
              started_at: incident.start,
            }),
          })
    },
    onSuccess: () => {
      toast.success("Follow-up saved")
      onSaved()
      onDone()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FormStatusSelect
        label="Cause"
        value={cause}
        onChange={setCause}
        options={causes.data?.results ?? []}
        noneLabel="No cause"
        placeholder="Pick a cause"
        error={fieldErrors.cause}
      />
      <FormText
        label="Ticket"
        value={ticket}
        onChange={setTicket}
        placeholder="https://tickets.example.com/INC-4411"
        error={fieldErrors.ticket_url}
      />
      <FormTextarea
        label="Note"
        value={note}
        onChange={setNote}
        rows={3}
        info="Stays in Danbyte; reports leave it out."
        error={fieldErrors.note}
      />
      <FormCheckbox
        label="Disputed"
        checked={disputed}
        onChange={setDisputed}
        info="Marked on the incident and in reports. It still counts; add an exclusion to take the time out."
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </form>
  )
}

/** Down time per cause, most first; the incidents without one last. */
export function SlaDownByCause({ rows }: { rows: SlaCauseRow[] }) {
  if (!rows.length) return null
  const max = Math.max(...rows.map((r) => r.down_s), 1)
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li
          key={r.cause ?? "none"}
          className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-[13px]"
        >
          <span className="min-w-0 truncate">
            {r.cause ? (
              <ColorBadge name={r.name} color={r.color || undefined} />
            ) : (
              <span className="text-muted-foreground">{r.name}</span>
            )}
          </span>
          <span className="h-2 rounded-sm bg-muted">
            <span
              className="block h-full rounded-sm bg-destructive/70"
              style={{ width: `${(100 * r.down_s) / max}%` }}
            />
          </span>
          <span className="num text-right whitespace-nowrap text-muted-foreground">
            {fmtSpan(r.down_s * 1000)} · {r.incidents}
            {r.disputed_s > 0 && ` · ${fmtSpan(r.disputed_s * 1000)} disputed`}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The tenant's incident cause catalog. Opened from the SLAs list. */
export function SlaCausesButton() {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  if (!canDo("slaincidentcause", "view")) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Tags className="h-3.5 w-3.5" /> Causes
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Incident causes</DialogTitle>
            <DialogDescription>
              Picked when following up an incident.
            </DialogDescription>
          </DialogHeader>
          {open && <Causes />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Causes() {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const q = useSlaCauses()
  const [editing, setEditing] = useState<SlaIncidentCause | "new" | null>(null)
  const [deleting, setDeleting] = useState<SlaIncidentCause | null>(null)
  const del = useMutation({
    mutationFn: (c: SlaIncidentCause) =>
      api<void>(`${CAUSES}${c.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Cause deleted")
      setDeleting(null)
      qc.invalidateQueries({ queryKey: ["sla-incident-causes"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (editing)
    return (
      <CauseForm
        cause={editing === "new" ? undefined : editing}
        onDone={() => setEditing(null)}
      />
    )
  return (
    <div className="grid gap-3">
      {rows.length === 0 ? (
        <EmptyState title="No causes yet." />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <ColorBadge name={c.name} color={c.color || undefined} />
                {c.description && (
                  <div className="truncate text-xs text-muted-foreground">
                    {c.description}
                  </div>
                )}
              </div>
              <span className="num text-xs text-muted-foreground">
                {c.incident_count}
              </span>
              {canDo("slaincidentcause", "change") && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Edit ${c.name}`}
                      onClick={() => setEditing(c)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent variant="default">Edit</TooltipContent>
                </Tooltip>
              )}
              {canDo("slaincidentcause", "delete") && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${c.name}`}
                      onClick={() => setDeleting(c)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent variant="default">Delete</TooltipContent>
                </Tooltip>
              )}
            </li>
          ))}
        </ul>
      )}
      {canDo("slaincidentcause", "add") && (
        <div>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-3.5 w-3.5" /> New cause
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "cause"}?`}
        description="Incidents with this cause keep their other follow-up and show no cause."
        confirmLabel="Delete"
        pendingLabel="Deleting…"
        destructive
        pending={del.isPending}
        onConfirm={() => deleting && del.mutate(deleting)}
      />
    </div>
  )
}

function CauseForm({
  cause,
  onDone,
}: {
  cause?: SlaIncidentCause
  onDone: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(cause?.name ?? "")
  const [color, setColor] = useState(cause?.color ?? "")
  const [description, setDescription] = useState(cause?.description ?? "")
  const save = useMutation({
    mutationFn: () => {
      reset()
      const body = JSON.stringify({ name: name.trim(), color, description })
      return cause
        ? api(`${CAUSES}${cause.id}/`, { method: "PATCH", body })
        : api(CAUSES, { method: "POST", body })
    },
    onSuccess: () => {
      toast.success(cause ? `Updated ${name}` : `Created ${name}`)
      qc.invalidateQueries({ queryKey: ["sla-incident-causes"] })
      onDone()
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FormText
        label="Name"
        value={name}
        onChange={setName}
        required
        placeholder="Carrier"
        error={fieldErrors.name}
      />
      <FormColor
        label="Colour"
        value={color}
        onChange={setColor}
        error={fieldErrors.color}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        rows={2}
        error={fieldErrors.description}
      />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : cause ? "Save" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  )
}
