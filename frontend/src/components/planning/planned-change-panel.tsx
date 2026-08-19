import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import {
  ArrowRight,
  CalendarClock,
  Check,
  TriangleAlert,
  X,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  ApiError,
  type PlanningPlannedChange,
  type PlanningTask,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useDateFormat } from "@/lib/datetime"
import { useCustomizationMeta } from "@/lib/custom-fields"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { apiErrorToast } from "@/lib/api-toast"
import { OBJECT_DETAIL_ROUTES } from "@/lib/object-routes"
import { ObjectRow, objectIcon, slugFromObjectType } from "./object-chip"

/** What a task will change, grouped by the object it changes.
 *
 * Each row is one saved edit of the object's own form, rendered as the diff the
 * server computed: `Label  old → new`. Applying writes it into Danbyte's record
 * - never to the device - and is offered only to someone who may change (or, for
 * a create, add) that kind of object. */
export function PlannedChangePanel({
  task,
  canEdit,
}: {
  task: PlanningTask
  canEdit: boolean
}) {
  const changes = task.planned_changes ?? []
  const { canDo } = useMe()
  const meta = useCustomizationMeta()

  // Group by target. A create has no object yet, so it groups by type.
  const groups = useMemo(() => {
    const by = new Map<string, PlanningPlannedChange[]>()
    for (const c of changes) {
      const key = `${c.object_type}|${c.object_id ?? "new"}`
      const hit = by.get(key)
      if (hit) hit.push(c)
      else by.set(key, [c])
    }
    return [...by.values()]
  }, [changes])

  const open = changes.filter((c) => c.state === "planned").length
  if (changes.length === 0) {
    return (
      <section className="space-y-2">
        <Header count={0} />
        <div className="flex items-start gap-3 rounded-lg border border-dashed border-border px-3 py-4">
          <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p className="text-[13px] text-muted-foreground">
            Nothing planned yet. Use <strong>Plan</strong> on a linked object
            above - it opens that object's own edit form, and whatever you
            change is recorded here instead of being written.
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-2">
      <Header count={open || changes.length} openLabel={open > 0} />
      {/* One frame around the list, like linked objects - a single planned
          change used to arrive as a box inside a box. */}
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
        {groups.map((rows) => {
          const first = rows[0]
          const slug = slugFromObjectType(first.object_type)
          const typeLabel =
            meta.data?.reference_models.find((r) => r.value === slug)?.label ??
            slug
          const Icon = objectIcon(slug)
          return (
            <div key={`${first.object_type}|${first.object_id ?? "new"}`}>
              {first.object_id ? (
                <ObjectRow
                  slug={slug}
                  id={first.object_id}
                  typeLabel={typeLabel}
                />
              ) : (
                <div className="flex items-center gap-2 bg-muted/30 px-3 py-2">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="text-[13px] font-medium">
                    New {typeLabel.replace(/s$/, "").toLowerCase()}
                  </span>
                  <Badge variant="secondary" className="text-[10px]">
                    not created yet
                  </Badge>
                </div>
              )}
              <div className="divide-y divide-border/60">
                {rows.map((c) => (
                  <ChangeSetRow
                    key={c.id}
                    change={c}
                    canEdit={canEdit}
                    canApply={canDo(slug, c.object_id ? "change" : "add")}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function Header({ count, openLabel }: { count: number; openLabel?: boolean }) {
  return (
    <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
      Planned changes
      {count > 0 && (
        <span className="num ml-1.5 font-normal">
          {openLabel ? `${count} open` : count}
        </span>
      )}
    </h3>
  )
}

function ChangeSetRow({
  change: c,
  canEdit,
  canApply,
}: {
  change: PlanningPlannedChange
  canEdit: boolean
  canApply: boolean
}) {
  const qc = useQueryClient()
  const { formatDate, today } = useDateFormat()
  /** Field key → its live value, when apply came back 409. */
  const [conflict, setConflict] = useState<Record<string, string> | null>(null)

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["planning-tasks"] })
    qc.invalidateQueries({ queryKey: ["planned-changes-map"] })
    qc.invalidateQueries({ queryKey: ["planned-changes-for"] })
    // The object itself changed - its detail page and lists must not go stale.
    qc.invalidateQueries({ queryKey: ["device"] })
    qc.invalidateQueries({ queryKey: ["device-interfaces"] })
    qc.invalidateQueries({ queryKey: ["interfaces"] })
  }

  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) =>
      api(`/api/planning/planned-changes/${c.id}/${path}`, {
        method: "POST",
        body: JSON.stringify(body ?? {}),
      }),
    onSuccess: () => invalidate(),
  })

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/planning/planned-changes/${c.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Plan removed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const applied = () =>
    toast.success(
      c.object_id ? "Change applied" : "Created - the object now exists"
    )

  /** A 409 means the object moved since planning. Rather than failing, collect
   *  what changed and ask - in a real dialog, since this is a decision about
   *  overwriting someone else's edit. */
  const applyNow = () =>
    act.mutate(
      { path: "apply/" },
      {
        onSuccess: applied,
        onError: (e) => {
          const body =
            e instanceof ApiError && e.status === 409
              ? (e.body as
                  | {
                      stale_fields?: string[]
                      current_display?: Record<string, string>
                    }
                  | undefined)
              : undefined
          if (!body?.current_display) return apiErrorToast(e)
          setConflict(body.current_display)
        },
      }
    )

  const forceApply = () =>
    act.mutate(
      { path: "apply/", body: { force: true } },
      {
        onSuccess: () => {
          setConflict(null)
          applied()
        },
        onError: (err) => {
          setConflict(null)
          apiErrorToast(err)
        },
      }
    )

  const done = c.state !== "planned"
  const due = c.effective_date
  const overdue = !!due && !done && due < today
  const rows = c.display ?? []

  return (
    <div className="group space-y-1.5 px-3 py-2.5">
      <div className="space-y-1">
        {rows.map((d, i) => (
          <span
            key={`${d.field}-${i}`}
            className="flex min-w-0 flex-wrap items-center gap-1.5 text-[13px]"
          >
            <span className="text-muted-foreground">{d.label || d.field}</span>
            {c.object_id && (
              <>
                <span className="font-mono line-through opacity-60">
                  {d.from || "-"}
                </span>
                <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
              </>
            )}
            <span className={`font-mono ${done ? "opacity-70" : ""}`}>
              {d.to || "-"}
            </span>
          </span>
        ))}
        {rows.length === 0 && (
          <span className="text-[13px] text-muted-foreground">
            No visible field changes.
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {c.stale && !done && (
          <span
            className="inline-flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400"
            title="The object's live values changed since this was planned."
          >
            <TriangleAlert className="h-3 w-3" /> changed since planned
          </span>
        )}
        {due && !done && (
          <span
            className={`inline-flex items-center gap-1 text-[11px] ${
              overdue
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground"
            }`}
            title={
              c.planned_for
                ? "This change's own date"
                : "From the task's due date"
            }
          >
            <CalendarClock className="h-3 w-3" /> {formatDate(due)}
          </span>
        )}
        {c.state === "applied" && (
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Check className="h-3 w-3" /> Applied
            {c.applied_by_username ? ` by ${c.applied_by_username}` : ""}
            {c.applied_at && " · "}
            {c.applied_at && <TimeCell iso={c.applied_at} />}
          </span>
        )}
        {c.state === "cancelled" && (
          <span className="text-[11px] text-muted-foreground">Cancelled</span>
        )}
        {c.created_object_id && OBJECT_DETAIL_ROUTES[c.object_type] && (
          <Link
            to={OBJECT_DETAIL_ROUTES[c.object_type].replace(
              "$id",
              c.created_object_id
            )}
            className="link text-[11px]"
          >
            View created object
          </Link>
        )}
        {c.note && (
          <span className="text-[11px] text-muted-foreground">{c.note}</span>
        )}

        {!done && canEdit && (
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {canApply && (
              <Button
                size="sm"
                variant="secondary"
                disabled={act.isPending}
                onClick={applyNow}
              >
                {act.isPending
                  ? "Applying..."
                  : c.object_id
                    ? "Apply"
                    : "Create now"}
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={act.isPending}
              onClick={() =>
                act.mutate(
                  { path: "cancel/" },
                  {
                    onSuccess: () => toast.success("Plan cancelled"),
                    onError: (e) => apiErrorToast(e),
                  }
                )
              }
            >
              Cancel
            </Button>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
              title="Remove this plan"
              onClick={() => remove.mutate()}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>

      <AlertDialog
        open={!!conflict}
        onOpenChange={(open) => !open && setConflict(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              This object changed since the plan was written
            </AlertDialogTitle>
            <AlertDialogDescription>
              Someone edited the same fields. Applying now overwrites their
              values with the planned ones.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="divide-y divide-border rounded-lg border border-border text-[13px]">
            {Object.entries(conflict ?? {}).map(([field, live]) => {
              const row = rows.find((d) => d.field === field)
              return (
                <div key={field} className="grid gap-0.5 px-3 py-2">
                  <span className="text-[11px] tracking-wide text-muted-foreground uppercase">
                    {row?.label || field}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground">now</span>
                    <span className="font-mono">{live || "-"}</span>
                    <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="text-muted-foreground">planned</span>
                    <span className="font-mono font-medium">
                      {row?.to || "-"}
                    </span>
                  </span>
                </div>
              )
            })}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={act.isPending}>
              Leave it alone
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={act.isPending}
              onClick={(e) => {
                e.preventDefault()
                forceApply()
              }}
            >
              {act.isPending ? "Applying..." : "Overwrite and apply"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
