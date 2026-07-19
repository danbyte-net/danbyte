import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Activity, ChevronRight, Plus, Radio, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AssignmentOverrides,
  type CheckStatus,
  type PrefixCheckAssignment,
  type PrefixChecksResponse,
  type PrefixIpStatus,
  type ScheduleMode,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { CheckStatusBadge } from "./status-badge"
import { MixedStatusBadge } from "./mixed-status-badge"
import { STATUS_COLOR, STATUS_LABEL } from "./charts"
import { AddCheckDialog } from "./add-check-dialog"
import { DiscoverNowButton } from "./auto-discover-button"
import { apiErrorToast } from "@/lib/api-toast"

const SCHEDULE_LABELS: Record<ScheduleMode, string> = {
  follow_global: "Follow global",
  custom_on: "Always on",
  custom_off: "Off",
}

export function PrefixMonitoring({
  prefix,
}: {
  prefix: { id: string; cidr: string; auto_discover?: boolean }
}) {
  const [adding, setAdding] = useState(false)

  const q = useQuery({
    queryKey: ["prefix-checks", prefix.id],
    queryFn: () =>
      api<PrefixChecksResponse>(
        `/api/monitoring/prefixes/${prefix.id}/checks/`
      ),
  })

  const data = q.data
  const assignments = data?.assignments ?? []

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          Monitoring
        </h2>
        {data && <RollupSummary rollup={data.rollup} />}
        {data?.engine && !data.engine.is_local && (
          <Badge
            variant="secondary"
            className="gap-1 text-[10px]"
            title="Monitored by this Outpost"
          >
            <Radio className="h-3 w-3" />
            {data.engine.name}
          </Badge>
        )}
        <DiscoveryToggle
          prefixId={prefix.id}
          initial={prefix.auto_discover ?? false}
        />
        <DiscoverNowButton prefixId={prefix.id} onDone={() => q.refetch()} />
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" /> Add prefix check
        </Button>
      </div>

      {/* Prefix-level assignments */}
      <section className="space-y-2">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Prefix checks
        </h3>
        <div className="overflow-hidden rounded-lg border border-border">
          {q.isLoading && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
          )}
          {data && assignments.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No prefix-level checks. Add one and it applies to every IP in this
              prefix (minus any you exclude).
            </p>
          )}
          {assignments.map((a, i) => (
            <AssignmentRow
              key={a.id}
              prefixId={prefix.id}
              a={a}
              ips={data?.ips ?? []}
              striped={i % 2 === 1}
            />
          ))}
        </div>
      </section>

      {/* Per-IP status grid */}
      {data && data.ips.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Per-IP status{" "}
            <span className="text-muted-foreground/70">
              ({data.rollup.monitored_ips} monitored / {data.rollup.total_ips}{" "}
              in prefix)
            </span>
          </h3>
          <div className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
            {data.ips.map((ip) => (
              <Link
                key={ip.id}
                to="/ips/$id"
                params={{ id: ip.id }}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-[13px] hover:bg-muted"
              >
                <MixedStatusBadge counts={ip.counts} status={ip.status} />
                <span className="font-mono">{ip.ip_address}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {ip.checks} check{ip.checks === 1 ? "" : "s"}
                </span>
              </Link>
            ))}
          </div>
          {data.truncated && (
            <p className="text-[11px] text-muted-foreground">
              Showing the first {data.ips.length} monitored IPs.
            </p>
          )}
        </section>
      )}

      <AddCheckDialog
        target={{ kind: "prefix", id: prefix.id, label: prefix.cidr }}
        open={adding}
        onOpenChange={setAdding}
      />
    </div>
  )
}

// Always-visible up / down / degraded / stale / skipped breakdown chips.
const BREAKDOWN: CheckStatus[] = ["up", "down", "degraded", "stale", "skipped"]

function DiscoveryToggle({
  prefixId,
  initial,
}: {
  prefixId: string
  initial: boolean
}) {
  const qc = useQueryClient()
  const [on, setOn] = useState(initial)
  const m = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/prefixes/${prefixId}/`, {
        method: "PATCH",
        body: JSON.stringify({ auto_discover: next }),
      }),
    onSuccess: (_d, next) => {
      toast.success(next ? "Auto-discovery on" : "Auto-discovery off")
      qc.invalidateQueries({ queryKey: ["prefix", prefixId] })
    },
    onError: (err, next) => {
      setOn(!next) // revert
      apiErrorToast(err)
    },
  })
  return (
    <label
      className="ml-auto flex items-center gap-2 text-[12px] text-muted-foreground"
      title="Periodically ICMP-sweep this prefix and auto-create IPs for new responders (requires discovery enabled in monitoring settings)."
    >
      <Checkbox
        checked={on}
        onCheckedChange={(v) => {
          setOn(!!v)
          m.mutate(!!v)
        }}
      />
      Auto-discover
    </label>
  )
}

function RollupSummary({ rollup }: { rollup: PrefixChecksResponse["rollup"] }) {
  if (rollup.monitored_ips === 0)
    return (
      <span className="text-[11px] text-muted-foreground">
        no monitored IPs
      </span>
    )
  return (
    <div className="flex flex-wrap items-center gap-3">
      {rollup.status && <CheckStatusBadge status={rollup.status} />}
      <div className="flex items-center gap-3">
        {BREAKDOWN.map((s) => (
          <span
            key={s}
            className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
            title={STATUS_LABEL[s]}
          >
            <span
              className="h-2 w-2 rounded-[3px]"
              style={{ backgroundColor: STATUS_COLOR[s] }}
            />
            <span className="num text-foreground">{rollup.counts[s] ?? 0}</span>
            <span>{STATUS_LABEL[s].toLowerCase()}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

function AssignmentRow({
  prefixId,
  a,
  ips,
  striped,
}: {
  prefixId: string
  a: PrefixCheckAssignment
  ips: PrefixIpStatus[]
  striped: boolean
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["prefix-checks", prefixId] })

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/monitoring/assignments/${a.id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: invalidate,
    onError: (err) => apiErrorToast(err),
  })
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/assignments/${a.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Removed ${a.template.name}`)
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  // Override a single numeric key in the overrides JSON; empty clears it.
  const setOverride = (
    key: "interval_seconds" | "rise" | "fall",
    value: number | null
  ) => {
    const next: AssignmentOverrides = { ...a.overrides }
    if (value == null) delete next[key]
    else next[key] = value
    patch.mutate({ overrides: next })
  }
  const toggleExclusion = (ipId: string) => {
    const has = a.exclusions.includes(ipId)
    patch.mutate({
      exclusions: has
        ? a.exclusions.filter((x) => x !== ipId)
        : [...a.exclusions, ipId],
    })
  }

  const ov = a.overrides
  const overridden =
    ov.interval_seconds != null || ov.rise != null || ov.fall != null

  return (
    <div className={striped ? "bg-muted/30" : ""}>
      <div className="flex flex-wrap items-center gap-3 px-3 py-2 text-[13px]">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex items-center gap-1.5 text-left hover:text-foreground"
          title="Edit overrides & exclusions"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
              open ? "rotate-90" : ""
            }`}
          />
          <span className={`font-medium ${a.enabled ? "" : "opacity-50"}`}>
            {a.template.name}
          </span>
        </button>
        <span className="font-mono text-[11px] text-muted-foreground uppercase">
          {a.template.kind}
        </span>
        {!a.enabled && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            disabled
          </Badge>
        )}
        {overridden && (
          <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
            custom
          </Badge>
        )}
        {a.exclusions.length > 0 && (
          <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
            {a.exclusions.length} excluded
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Checkbox
              checked={a.apply_to_children}
              onCheckedChange={(v) => patch.mutate({ apply_to_children: !!v })}
            />
            Apply to children
          </label>

          <Select
            value={a.schedule_mode}
            onValueChange={(v) =>
              patch.mutate({ schedule_mode: v as ScheduleMode })
            }
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SCHEDULE_LABELS) as ScheduleMode[]).map((m) => (
                <SelectItem key={m} value={m}>
                  {SCHEDULE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            title="Remove check"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {open && (
        <div className="space-y-3 border-t border-border/60 bg-background/50 px-3 py-3">
          <label className="flex items-center gap-2 text-[12px]">
            <Checkbox
              checked={a.enabled}
              onCheckedChange={(v) => patch.mutate({ enabled: !!v })}
            />
            Enabled
            <span className="text-[11px] text-muted-foreground">
              (off = keep the assignment but don't run it)
            </span>
          </label>

          <div className="grid grid-cols-3 gap-3">
            <OverrideField
              label="Interval (s)"
              placeholder={a.template.interval_seconds}
              value={ov.interval_seconds}
              onCommit={(v) => setOverride("interval_seconds", v)}
            />
            <OverrideField
              label="Rise"
              placeholder={a.template.rise}
              value={ov.rise}
              onCommit={(v) => setOverride("rise", v)}
            />
            <OverrideField
              label="Fall"
              placeholder={a.template.fall}
              value={ov.fall}
              onCommit={(v) => setOverride("fall", v)}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Blank = inherit the template default. Overrides apply to this prefix
            assignment only.
          </p>

          {ips.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-muted-foreground uppercase">
                Exclude IPs from this check
              </span>
              <div className="flex max-h-40 flex-wrap gap-x-4 gap-y-1 overflow-auto">
                {ips.map((ip) => (
                  <label
                    key={ip.id}
                    className="flex items-center gap-1.5 text-[12px]"
                  >
                    <Checkbox
                      checked={a.exclusions.includes(ip.id)}
                      onCheckedChange={() => toggleExclusion(ip.id)}
                    />
                    <span className="font-mono">{ip.ip_address}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OverrideField({
  label,
  placeholder,
  value,
  onCommit,
}: {
  label: string
  placeholder: number
  value: number | undefined
  onCommit: (v: number | null) => void
}) {
  const [draft, setDraft] = useState(value != null ? String(value) : "")
  useEffect(() => {
    setDraft(value != null ? String(value) : "")
  }, [value])
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted-foreground">
      {label}
      <Input
        type="number"
        value={draft}
        placeholder={`${placeholder}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const trimmed = draft.trim()
          onCommit(trimmed === "" ? null : Number(trimmed))
        }}
        className="h-8 text-[13px]"
      />
    </label>
  )
}
