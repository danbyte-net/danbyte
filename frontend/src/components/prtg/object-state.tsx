import { useEffect } from "react"
import type { ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ExternalLink } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  PrtgApplyObjectResult,
  PrtgDeviceLink,
  PrtgPlanEntry,
  PrtgSync,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { PrtgIssueLine } from "./issues"

/** A device or VM, as the PRTG surfaces name it. */
export type PrtgObjectRef = { kind: "device" | "virtual_machine"; id: string }

export function planQuery(object: PrtgObjectRef): string {
  return object.kind === "device"
    ? `device=${object.id}`
    : `virtual_machine=${object.id}`
}

/** The plan for one object - one entry per connection. Polled every few
 * seconds while an apply is running, until PRTG has the device. */
export function usePrtgPlan(object: PrtgObjectRef, enabled = true) {
  const qs = planQuery(object)
  return useQuery({
    enabled,
    queryKey: ["prtg-plan", qs],
    queryFn: () => api<PrtgPlanEntry[]>(`/api/prtg/plan/?${qs}`),
    refetchInterval: (q) =>
      (q.state.data ?? []).some((e) => !e.linked && e.planned.applying)
        ? 3000
        : false,
  })
}

/** Add to PRTG now: plans the object and writes its ready rows - the
 * device, then its sensors - through the writer the queue uses. */
export function useAddToPrtgNow(object: PrtgObjectRef) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api<PrtgApplyObjectResult[]>("/api/prtg/changes/apply-object/", {
        method: "POST",
        body: JSON.stringify({ [object.kind]: object.id }),
      }),
    onSuccess: (out) => {
      for (const r of out) {
        if (r.link && !r.failed.length)
          toast.success(`Added to PRTG as ${r.link.name || r.link.objid}`)
        else if (r.link)
          toast.warning(
            `Added to PRTG; ${r.failed.length} failed: ${r.failed[0].detail}`
          )
        else if (r.failed.length) toast.error(r.failed[0].detail)
        else toast.info("Nothing ready to add. See the review queue.")
      }
    },
    onError: (e) => apiErrorToast(e),
    onSettled: () => {
      for (const key of [
        "prtg-plan",
        "prtg-links",
        "prtg-sensors",
        "prtg-changes",
      ])
        void qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

/** Where one connection stands for an object that has no PRTG device, or
 * has one without sensors. */
export type PrtgObjectStateKind =
  | "excluded"
  | "not_in_prtg"
  | "attention"
  | "planned"
  | "adding"
  | "linked_empty"
  | "linked"

export function prtgObjectState(
  e: PrtgPlanEntry,
  opts: { prtgSync?: PrtgSync; sensors?: number; adding?: boolean }
): PrtgObjectStateKind {
  if (e.linked) return opts.sensors === 0 ? "linked_empty" : "linked"
  if (opts.prtgSync === "never" || e.registration.mode === "never")
    return "excluded"
  if (opts.adding || e.planned.applying) return "adding"
  if (!e.registers) return "not_in_prtg"
  const statuses = e.planned.statuses ?? []
  if (
    (e.issues ?? []).length > 0 ||
    statuses.includes("attention") ||
    statuses.includes("failed") ||
    (e.last_apply && !e.last_apply.ok)
  )
    return "attention"
  return "planned"
}

const TITLE: Record<PrtgObjectStateKind, string> = {
  excluded: "Excluded from PRTG",
  not_in_prtg: "Not in PRTG",
  attention: "Needs attention",
  planned: "Planned for PRTG",
  adding: "Adding to PRTG…",
  linked_empty: "In PRTG, no sensors yet",
  linked: "In PRTG",
}

const VARIANT: Record<
  PrtgObjectStateKind,
  "secondary" | "warning" | "info" | "success"
> = {
  excluded: "secondary",
  not_in_prtg: "secondary",
  attention: "warning",
  planned: "info",
  adding: "info",
  linked_empty: "success",
  linked: "success",
}

/** The connection, named, linking to the PRTG page. */
function ConnectionName({ entry }: { entry: PrtgPlanEntry }) {
  return (
    <Link to="/prtg" className="link">
      {entry.connection.name}
    </Link>
  )
}

function ReviewQueueLink({ object }: { object: PrtgObjectRef }) {
  return (
    <Button size="sm" variant="outline" asChild>
      <Link to="/prtg" search={{ tab: "review", object: object.id }}>
        Open review queue
      </Link>
    </Button>
  )
}

function EditLink({ object }: { object: PrtgObjectRef }) {
  return object.kind === "device" ? (
    <Link to="/devices/$id/edit" params={{ id: object.id }} className="link">
      Edit device
    </Link>
  ) : (
    <Link
      to="/virtual-machines/$id/edit"
      params={{ id: object.id }}
      className="link"
    >
      Edit VM
    </Link>
  )
}

/** The Add to PRTG now button, when this viewer may apply. */
export function AddToPrtgNowButton({
  object,
  add,
}: {
  object: PrtgObjectRef
  add: ReturnType<typeof useAddToPrtgNow>
}) {
  const { canDo } = useMe()
  if (!canDo("prtgchange", "change")) return null
  return (
    <Button
      size="sm"
      disabled={add.isPending}
      onClick={() => add.mutate()}
      data-testid="prtg-add-now"
      aria-label={`Add ${object.kind === "device" ? "device" : "VM"} to PRTG now`}
    >
      {add.isPending ? "Adding…" : "Add to PRTG now"}
    </Button>
  )
}

/**
 * One connection's state card for a device or VM PRTG does not show
 * sensors for: Excluded, Not in PRTG (with the reason and its fix), Planned
 * (Add to PRTG now, Open review queue), Needs attention (the issues),
 * Adding to PRTG… (while an apply runs), or In PRTG with no sensors yet.
 */
export function PrtgObjectStateCard({
  entry: e,
  object,
  prtgSync,
  sensors,
  add,
  link,
  addSensors,
}: {
  entry: PrtgPlanEntry
  object: PrtgObjectRef
  prtgSync?: PrtgSync
  /** Sensors PRTG has on the linked device. */
  sensors?: number
  add: ReturnType<typeof useAddToPrtgNow>
  link?: PrtgDeviceLink
  /** Add sensor and Discover, for a linked device without sensors. */
  addSensors?: ReactNode
}) {
  const state = prtgObjectState(e, { prtgSync, sensors, adding: add.isPending })
  if (state === "linked") return null
  const issues = e.issues ?? e.problems.map((text) => ({ text }))
  const p = e.planned
  let body: ReactNode = null
  let actions: ReactNode = null
  if (state === "excluded") {
    body = (
      <p className="text-muted-foreground">
        Exclude from PRTG is set on this{" "}
        {object.kind === "device" ? "device" : "VM"}.{" "}
        <EditLink object={object} />
      </p>
    )
  } else if (state === "not_in_prtg") {
    body = p.reasons.length ? (
      p.reasons.map((i) => (
        <PrtgIssueLine
          key={i.text}
          issue={i}
          object={object}
          className="text-muted-foreground"
        />
      ))
    ) : (
      <p className="text-muted-foreground">Nothing registers it.</p>
    )
  } else if (state === "adding") {
    body = (
      <p className="text-muted-foreground">
        Creating the device
        {e.registration.group?.path
          ? ` in ${e.registration.group.path}`
          : ""}{" "}
        and its sensors. This updates when PRTG has them.
      </p>
    )
  } else if (state === "planned" || state === "attention") {
    body = (
      <>
        {state === "planned" && (
          <p className="text-muted-foreground">
            {e.connection.auto_apply
              ? "Applied automatically after the next planning pass."
              : "Waiting in the review queue."}
          </p>
        )}
        {(p.create_device || p.sensors.length > 0) && (
          <p>
            {p.create_device ? "Create the device" : "Add sensors"}
            {e.registration.group?.path && (
              <span className="text-muted-foreground">
                {" "}
                in {e.registration.group.path}
              </span>
            )}
            {p.sensors.length > 0 && (
              <span className="text-muted-foreground">
                {" "}
                · {p.sensors.map((s) => s.name).join(", ")}
              </span>
            )}
          </p>
        )}
        {issues.map((i) => (
          <PrtgIssueLine key={i.text} issue={i} object={object} />
        ))}
        {e.last_apply && !e.last_apply.ok && (
          <p
            className="text-xs break-words text-destructive"
            data-testid="prtg-last-apply-error"
          >
            Last apply failed <TimeCell iso={e.last_apply.at} />:{" "}
            {e.last_apply.detail}
          </p>
        )}
      </>
    )
    actions = (
      <>
        {(p.ready ?? (p.create_device ? 1 : 0)) > 0 && (
          <AddToPrtgNowButton object={object} add={add} />
        )}
        <ReviewQueueLink object={object} />
      </>
    )
  } else {
    body = (
      <p className="text-muted-foreground">
        PRTG has the device
        {e.linked && (
          <>
            {" "}
            <a
              href={e.linked.url}
              target="_blank"
              rel="noreferrer"
              className="link inline-flex items-center gap-1"
            >
              {e.linked.name || e.linked.objid}
              <ExternalLink className="h-3 w-3" />
            </a>
          </>
        )}{" "}
        but no sensors on it.
        {p.sensors.length > 0 &&
          " Its planned sensors wait in the review queue."}
      </p>
    )
    actions = (
      <>
        {addSensors}
        {p.queued > 0 && <ReviewQueueLink object={object} />}
      </>
    )
  }
  return (
    <div
      className="grid gap-2 rounded-lg border border-border bg-card p-4 text-[13px]"
      data-testid="prtg-object-state"
      data-state={state}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={VARIANT[state]}>{TITLE[state]}</Badge>
        <span className="text-xs text-muted-foreground">
          <ConnectionName entry={e} />
          {link?.created_here && " · created by Danbyte"}
        </span>
      </div>
      {body}
      {actions && (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  )
}

/** While an apply runs, the links and sensors refresh once PRTG has the
 * device. */
export function useRefreshWhenLinked(entries: PrtgPlanEntry[] | undefined) {
  const qc = useQueryClient()
  const linked = (entries ?? []).filter((e) => e.linked).length
  useEffect(() => {
    if (!linked) return
    void qc.invalidateQueries({ queryKey: ["prtg-links"] })
    void qc.invalidateQueries({ queryKey: ["prtg-sensors"] })
  }, [linked, qc])
}
