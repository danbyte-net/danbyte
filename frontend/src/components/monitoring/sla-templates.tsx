import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Layers, Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, SlaAgreement, SlaTemplate } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PERIOD_LABEL, fmtSla } from "./sla-figure"

export const TEMPLATES_URL = "/api/monitoring/sla-templates/"

/** The fields a template sets, as the agreement form labels them. */
export const TEMPLATE_FIELD_LABEL: Record<string, string> = {
  target_pct: "Target",
  warning_pct: "At risk below",
  period: "Period",
  timezone: "Timezone",
  service_hours: "Service hours",
  holiday_calendar_id: "Holidays",
  count_degraded_as: "Degraded counts as",
  count_stale_as: "Stale counts as",
  count_unknown_as: "Unknown counts as",
  exclude_maintenance: "Exclude maintenance",
  min_outage_seconds: "Ignore outages under",
  aggregation: "Members combine as",
  objectives: "Latency objectives",
  objectives_in_state: "Objectives count in the state",
  credit_tiers: "Credit tiers",
  period_fee: "Fee per period",
  currency: "Currency",
}

export function useSlaTemplates(enabled = true) {
  const { canDo } = useMe()
  return useQuery({
    queryKey: ["sla-templates"],
    queryFn: () =>
      api<Paginated<SlaTemplate>>(`${TEMPLATES_URL}?page_size=200`),
    enabled: enabled && canDo("slatemplate", "view"),
    staleTime: 60_000,
  })
}

/** "Differs" with the fields on hover, or "In sync". */
export function TemplateSyncBadge({ differs }: { differs: string[] }) {
  if (!differs.length) return <Badge variant="success">In sync</Badge>
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="warning">Differs · {differs.length}</Badge>
      </TooltipTrigger>
      <TooltipContent variant="default">
        {differs.map((f) => TEMPLATE_FIELD_LABEL[f] ?? f).join(", ")}
      </TooltipContent>
    </Tooltip>
  )
}

/** The agreement's template on its page, with Sync while it differs. */
export function SlaTemplateLine({
  agreement: a,
  onSynced,
}: {
  agreement: SlaAgreement
  onSynced: () => void
}) {
  const { canDo } = useMe()
  const t = a.template_detail
  const sync = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/sla-agreements/${a.id}/sync-template/`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success(`Synced with ${t?.name}`)
      onSynced()
    },
    onError: (e) => apiErrorToast(e),
  })
  if (!t) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      Template{" "}
      {canDo("slatemplate", "view") ? (
        <Link
          to="/monitoring/sla/templates/$id"
          params={{ id: t.id }}
          className="link"
        >
          {t.name}
        </Link>
      ) : (
        t.name
      )}
      <TemplateSyncBadge differs={t.differs} />
      {t.differs.length > 0 &&
        canDo("slaagreement", "change") &&
        canDo("slatemplate", "view") && (
          <Button
            size="sm"
            variant="link"
            className="h-auto p-0"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
          >
            {sync.isPending ? "Syncing…" : "Sync"}
          </Button>
        )}
    </span>
  )
}

/** Templates (tiers), opened from the SLAs list. */
export function SlaTemplatesButton() {
  const { canDo } = useMe()
  const [open, setOpen] = useState(false)
  if (!canDo("slatemplate", "view")) return null
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Layers className="h-3.5 w-3.5" /> Templates
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>SLA templates</DialogTitle>
            <DialogDescription>
              Rules an agreement is made from and kept in sync with.
            </DialogDescription>
          </DialogHeader>
          {open && <Templates onLeave={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Templates({ onLeave }: { onLeave: () => void }) {
  const { canDo } = useMe()
  const q = useSlaTemplates()
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="grid gap-3">
      {rows.length === 0 ? (
        <EmptyState title="No templates yet." />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <Link
                  to="/monitoring/sla/templates/$id"
                  params={{ id: t.id }}
                  className="link text-[13px] font-medium"
                  onClick={onLeave}
                >
                  {t.name}
                </Link>
                <div className="num text-xs text-muted-foreground">
                  {fmtSla(Number(t.target_pct))} · {PERIOD_LABEL[t.period]}
                </div>
              </div>
              <span className="num text-xs whitespace-nowrap text-muted-foreground">
                {t.agreement_count} agreement
                {t.agreement_count === 1 ? "" : "s"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canDo("slatemplate", "add") && (
        <div>
          <Button size="sm" asChild>
            <Link to="/monitoring/sla/templates/new" onClick={onLeave}>
              <Plus className="h-3.5 w-3.5" /> New template
            </Link>
          </Button>
        </div>
      )}
    </div>
  )
}
