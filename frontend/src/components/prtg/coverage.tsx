import { useState } from "react"
import type { ReactNode } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Check, ChevronDown, ChevronRight } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { PrtgCoverage, PrtgCoverageStatus, PrtgPlanEntry } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { PrtgIssueLine } from "./issues"
import { usePrtgPlan } from "./object-state"
import type { PrtgObjectRef } from "./object-state"

type Wanted = PrtgCoverage["wanted"][number]
type Extra = PrtgCoverage["extra"][number]

const STATUS: Record<
  Exclude<PrtgCoverageStatus, "present">,
  { label: string; variant: "info" | "destructive" | "warning" | "secondary" }
> = {
  planned: { label: "Planned", variant: "info" },
  failed: { label: "Failed", variant: "destructive" },
  waiting: { label: "Waiting", variant: "warning" },
  skipped: { label: "Skipped", variant: "secondary" },
}

const ORIGIN: Record<Extra["origin"], string> = {
  manual: "Added in Danbyte",
  danbyte: "Old definition",
  prtg: "Made in PRTG",
}

const MODE: Partial<Record<string, string>> = {
  always: "Monitor in PRTG",
  register_all: "Register all",
}

/** Whether the strip is open: the viewer's last choice for a complete or an
 * incomplete strip, remembered per browser; closed when complete, open
 * otherwise until they choose. */
function useOpen(complete: boolean): [boolean, (v: boolean) => void] {
  const key = `danbyte.prtg.coverage.${complete ? "complete" : "incomplete"}`
  const read = () => {
    try {
      const v = window.localStorage.getItem(key)
      if (v === "1" || v === "0") return v === "1"
    } catch {
      // Storage blocked: fall back to the default.
    }
    return !complete
  }
  const [choice, setChoice] = useState<Record<string, boolean>>({})
  const open = choice[key] ?? read()
  return [
    open,
    (v) => {
      setChoice((c) => ({ ...c, [key]: v }))
      try {
        window.localStorage.setItem(key, v ? "1" : "0")
      } catch {
        // Storage blocked: the strip still toggles, it is just not remembered.
      }
    },
  ]
}

/** The coverage strips for a device or VM in PRTG: one per connection
 * whose plan wants sensors or finds some no policy wants. */
export function PrtgCoverageStrips({ object }: { object: PrtgObjectRef }) {
  const plan = usePrtgPlan(object)
  const entries = Array.isArray(plan.data) ? plan.data : []
  const shown = entries.filter(
    (e) =>
      e.linked &&
      e.coverage &&
      (e.coverage.wanted.length > 0 || e.coverage.extra.length > 0)
  )
  if (!shown.length) return null
  return (
    <>
      {shown.map((e) => (
        <PrtgCoverageCard
          key={e.connection.id}
          entry={e}
          coverage={e.coverage!}
          object={object}
          named={shown.length > 1}
        />
      ))}
    </>
  )
}

function useApply() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      api<{ ok?: boolean; detail?: string }>(`/api/prtg/changes/${id}/apply/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.ok === false) toast.error(r.detail ?? "Failed")
      else toast.success(r.detail ?? "Applied")
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

/** One connection's coverage: the policies and how many of their sensors
 * PRTG has; open, a row per wanted sensor and the ones no policy wants. */
export function PrtgCoverageCard({
  entry,
  coverage: c,
  object,
  named = false,
}: {
  entry: PrtgPlanEntry
  coverage: PrtgCoverage
  object: PrtgObjectRef
  named?: boolean
}) {
  const complete = c.present === c.wanted.length && c.extra.length === 0
  const [open, setOpen] = useOpen(complete)
  const { canDo } = useMe()
  const apply = useApply()
  const mayApply = canDo("prtgchange", "change")
  // A new device's sensors share its create row: one button, on the first.
  const withButton = new Set<string>()
  const seen = new Set<string>()
  for (const w of c.wanted)
    if (w.change_id && !seen.has(w.change_id)) {
      seen.add(w.change_id)
      withButton.add(w.key)
    }
  const mode = MODE[entry.registration.mode]

  return (
    <div
      className="rounded-lg border border-border bg-card text-sm"
      data-testid="prtg-coverage"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1">
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md font-medium focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-3.5 text-muted-foreground" />
          )}
          Coverage
        </button>
        {named && (
          <span className="text-muted-foreground">{entry.connection.name}</span>
        )}
        <span className="inline-flex min-w-0 flex-wrap items-center gap-x-2">
          {c.policies.map((p) => (
            <Link
              key={p.id}
              to="/prtg"
              search={{ tab: "policies", policy: p.id }}
              className="link"
            >
              {p.name}
            </Link>
          ))}
          {!c.policies.length && mode && (
            <span className="text-muted-foreground">{mode}</span>
          )}
        </span>
        {c.group?.path && (
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {c.group.path}
          </span>
        )}
        <span
          className="ml-auto text-xs whitespace-nowrap text-muted-foreground"
          data-testid="prtg-coverage-summary"
        >
          {c.wanted.length > 0 &&
            `${c.present} of ${c.wanted.length} ${c.wanted.length === 1 ? "sensor" : "sensors"}`}
          {c.wanted.length > 0 && c.extra.length > 0 && " · "}
          {c.extra.length > 0 && `${c.extra.length} not from a policy`}
        </span>
      </div>
      {open && (
        <div className="border-t border-border">
          {c.wanted.map((w) => (
            <WantedRow
              key={w.key}
              row={w}
              object={object}
              action={
                mayApply && withButton.has(w.key) ? (
                  <RowAction row={w} apply={apply} />
                ) : null
              }
            />
          ))}
          {c.extra.length > 0 && (
            <>
              <p className="px-3 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
                Not from a policy
              </p>
              {c.extra.map((x) => (
                <div
                  key={x.sensor_id}
                  className="flex min-h-7 items-center gap-2 px-3 py-0.5"
                  data-testid="prtg-coverage-extra"
                >
                  <span className="min-w-0 truncate">{x.name || x.objid}</span>
                  <span className="hidden truncate text-xs text-muted-foreground sm:inline">
                    {x.kind_label}
                  </span>
                  <span className="ml-auto text-xs whitespace-nowrap text-muted-foreground">
                    {ORIGIN[x.origin]}
                  </span>
                </div>
              ))}
            </>
          )}
          <div className="h-1" />
        </div>
      )}
    </div>
  )
}

function RowAction({
  row,
  apply,
}: {
  row: Wanted
  apply: ReturnType<typeof useApply>
}) {
  if (!row.change_id || (row.status !== "planned" && row.status !== "failed"))
    return null
  const busy = apply.isPending && apply.variables === row.change_id
  return (
    <Button
      size="xs"
      variant={row.status === "failed" ? "outline" : "default"}
      disabled={apply.isPending}
      onClick={() => apply.mutate(row.change_id!)}
    >
      {busy ? "Applying…" : row.status === "failed" ? "Retry" : "Apply"}
    </Button>
  )
}

function WantedRow({
  row: w,
  object,
  action,
}: {
  row: Wanted
  object: PrtgObjectRef
  action: ReactNode
}) {
  const state = w.status === "present" ? null : STATUS[w.status]
  const note = w.issue ? w.issue : w.reason ? { text: w.reason } : null
  return (
    <div className="px-3 py-0.5" data-testid="prtg-coverage-row">
      <div className="flex min-h-7 items-center gap-2">
        <span className="min-w-0 truncate">{w.name}</span>
        <span className="hidden truncate text-xs text-muted-foreground sm:inline">
          {w.kind_label}
        </span>
        <span className="ml-auto inline-flex shrink-0 items-center gap-1.5">
          {action}
          {state ? (
            <Badge variant={state.variant}>{state.label}</Badge>
          ) : (
            <Check
              className="size-3.5 text-muted-foreground"
              aria-label="In PRTG"
            />
          )}
        </span>
      </div>
      {state && note && (
        <PrtgIssueLine
          issue={note}
          object={object}
          className={
            w.status === "failed"
              ? "pb-1 text-xs text-destructive"
              : w.status === "waiting"
                ? "pb-1 text-xs text-amber-600 dark:text-amber-400"
                : "pb-1 text-xs text-muted-foreground"
          }
        />
      )}
    </div>
  )
}
