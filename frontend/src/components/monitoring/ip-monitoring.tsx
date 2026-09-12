import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronRight, Play, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { ExternalDetailPanel } from "./external-detail"

import {
  api,
  type AssignmentOverrides,
  type CheckNowResponse,
  type CheckStatus,
  type EffectiveCheck,
  type IpChecksResponse,
  type IpTimeline,
  type ScheduleMode,
  type StatusSegment,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
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
import { Section } from "@/components/ui/section"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { AddCheckDialog } from "./add-check-dialog"
import { NotifyMeButton } from "./notify-me-button"
import { CheckHistory } from "./check-history"
import { FastBadge } from "./fast-badge"
import { FlappingPill } from "./flapping-pill"
import { HistoryPanel } from "./history-panel"
import { LatencyChart } from "./latency-chart"
import { StatusStrip } from "./status-strip"
import { ZabbixHostPanel } from "./zabbix-host-panel"
import { InfoTip } from "@/components/ui/info-tip"
import { apiErrorToast } from "@/lib/api-toast"

export function IpMonitoring({
  ip,
}: {
  ip: { id: string; ip_address: string; flap_exclude?: boolean }
}) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [flapExclude, setFlapExclude] = useState(ip.flap_exclude ?? false)
  // One fetch for every row's seven-day strip - the panel below has its own
  // window and its own query, so changing that never redraws the rows.
  const strips = useQuery({
    queryKey: ["monitoring-timeline", `ips/${ip.id}`, 7],
    queryFn: () =>
      api<IpTimeline>(`/api/monitoring/ips/${ip.id}/timeline/?days=7`),
  })
  const stripFor = (templateId: string) =>
    strips.data?.checks.find((c) => c.template_id === templateId)

  const flapM = useMutation({
    mutationFn: (next: boolean) =>
      api(`/api/ips/${ip.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ flap_exclude: next }),
      }),
    onSuccess: (_d, next) => {
      toast.success(
        next ? "Excluded from flapping monitor" : "Back in flapping monitor"
      )
      qc.invalidateQueries({ queryKey: ["ip", ip.id] })
    },
    onError: (err, next) => {
      setFlapExclude(!next)
      apiErrorToast(err)
    },
  })

  const q = useQuery({
    queryKey: ["ip-checks", ip.id],
    queryFn: () =>
      api<IpChecksResponse>(`/api/monitoring/ips/${ip.id}/checks/`),
  })

  // "I looked, it is fine": clears the flapping state and records who said
  // so. Different from Ignore flapping, which stops it ever being flagged.
  const confirmCalm = useMutation({
    mutationFn: (templateId?: string) =>
      api<{ cleared: number }>(`/api/monitoring/ips/${ip.id}/flapping/clear/`, {
        method: "POST",
        body: JSON.stringify(templateId ? { template_id: templateId } : {}),
      }),
    onSuccess: (d) => {
      toast.success(
        d.cleared === 1
          ? "Confirmed not flapping"
          : `Confirmed ${d.cleared} checks`
      )
      qc.invalidateQueries({ queryKey: ["ip-checks", ip.id] })
      qc.invalidateQueries({ queryKey: ["monitoring-flapping"] })
      // Every list's monitoring column reads the same roll-up.
      qc.invalidateQueries({
        predicate: (q) => String(q.queryKey[0]).endsWith("-mon-status"),
      })
    },
    onError: (err) => apiErrorToast(err),
  })

  const checkNow = useMutation({
    mutationFn: () =>
      api<CheckNowResponse>(`/api/monitoring/ips/${ip.id}/check-now/`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      const up = data.results.filter((r) => r.status === "up").length
      toast.success(
        `Ran ${data.count} check${data.count === 1 ? "" : "s"} - ${up} up`
      )
      qc.invalidateQueries({ queryKey: ["ip-checks", ip.id] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const checks = q.data?.checks ?? []
  const counts = checks.reduce<Partial<Record<CheckStatus, number>>>(
    (acc, c) => {
      const s = c.state?.status ?? "unknown"
      acc[s] = (acc[s] ?? 0) + 1
      return acc
    },
    {}
  )

  const flapping = q.data?.flapping ?? 0

  return (
    <div className="space-y-6">
      {/* One Section per thing, heading outside the card, actions on the
          right - the KvCard / SNMP-tab convention, so the tab reads as
          three plain sections rather than four differently-framed cards. */}
      <Section
        title="Checks"
        count={checks.length || undefined}
        badge={
          <>
            {checks.length > 0 && <MixedStatusBadge counts={counts} />}
            {flapping > 0 && <FlappingPill count={flapping} />}
          </>
        }
        actions={
          <>
            {flapping > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => confirmCalm.mutate(undefined)}
                disabled={confirmCalm.isPending}
              >
                {confirmCalm.isPending ? "Confirming…" : "Confirm not flapping"}
              </Button>
            )}
            <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Checkbox
                checked={flapExclude}
                onCheckedChange={(v) => {
                  setFlapExclude(!!v)
                  flapM.mutate(!!v)
                }}
              />
              Ignore flapping
              <InfoTip>
                Never flag this address as flapping - for a known noisy host.
                Confirm not flapping clears the flag once; this stops it being
                raised at all.
              </InfoTip>
            </label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => checkNow.mutate()}
              disabled={checkNow.isPending || checks.length === 0}
            >
              <Play className="h-3.5 w-3.5" />
              {checkNow.isPending ? "Checking…" : "Check now"}
            </Button>
            <NotifyMeButton ip={ip.id} />
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add check
            </Button>
          </>
        }
      >
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {q.data && checks.length === 0 && (
          <EmptyState title="No checks yet.">
            Add one to start monitoring this address.
          </EmptyState>
        )}
        {checks.length > 0 && (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {checks.map((c) => (
              <CheckRow
                key={c.template_id}
                ipId={ip.id}
                check={c}
                expanded={expanded === c.template_id}
                onToggle={() =>
                  setExpanded(expanded === c.template_id ? null : c.template_id)
                }
                strip={
                  strips.data
                    ? {
                        segments: stripFor(c.template_id)?.segments ?? [],
                        since: strips.data.since,
                        until: strips.data.until,
                      }
                    : undefined
                }
              />
            ))}
          </div>
        )}
      </Section>

      <ZabbixHostPanel scope={{ ip: ip.id }} />
      {checks.length > 0 && <HistoryPanel scope={{ ip: ip.id }} />}

      <AddCheckDialog
        target={{ kind: "ip", id: ip.id, label: ip.ip_address }}
        open={adding}
        onOpenChange={setAdding}
      />
    </div>
  )
}

function CheckRow({
  ipId,
  check,
  expanded,
  onToggle,
  strip,
}: {
  ipId: string
  check: EffectiveCheck
  expanded: boolean
  onToggle: () => void
  /** Seven days of status to scale - the row's one picture. The latency
   * chart is a click away in the expanded row. */
  strip?: { segments: StatusSegment[]; since: string; until: string }
}) {
  const qc = useQueryClient()
  const status = check.state?.status ?? "unknown"
  const latency = check.state?.last_latency_ms

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/assignments/${check.assignment_id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Removed ${check.template_name}`)
      qc.invalidateQueries({ queryKey: ["ip-checks", ipId] })
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <div>
      {/* The whole row is the disclosure: a chevron that turns, a hover
          tint and a pointer say so before anyone has to guess. */}
      <div className="flex items-center gap-3 px-3 py-2 text-[13px] transition-colors hover:bg-muted/50">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
        >
          <ChevronRight
            className={
              "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform " +
              (expanded ? "rotate-90" : "")
            }
          />
          <CheckStatusBadge status={status} />
          <span className="font-medium">{check.template_name}</span>
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            {check.kind}
          </span>
          {/* Provenance is a fact about the row, not a state: muted text,
              in the same run as the kind. The expanded row explains it. */}
          {check.source === "inherited" && (
            <span className="text-[11px] text-muted-foreground">
              · inherited
            </span>
          )}
          {check.source === "policy" && (
            <span className="text-[11px] text-muted-foreground">
              · from policy
            </span>
          )}
          {check.interval_ms && <FastBadge intervalMs={check.interval_ms} />}
          {check.state?.flapping_since && <FlappingPill />}
        </button>
        <span className="w-40 shrink-0">
          {strip && (
            <StatusStrip
              segments={strip.segments}
              since={strip.since}
              until={strip.until}
            />
          )}
        </span>
        <span className="num w-20 text-right text-xs text-muted-foreground">
          {latency != null ? `${latency.toFixed(1)} ms` : "-"}
        </span>
        <span className="w-24 text-right">
          {check.state?.last_checked ? (
            <TimeCell iso={check.state.last_checked} align="right" />
          ) : (
            <span className="text-xs text-muted-foreground">never run</span>
          )}
        </span>
        {check.source === "direct" && (
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
        )}
      </div>
      {expanded && (
        <div className="space-y-3 border-t border-border bg-background/60 px-3 py-3">
          <ExternalDetailPanel detail={check.state?.last_detail} />
          {check.source === "direct" ? (
            <OverridePanel ipId={ipId} check={check} />
          ) : check.source === "policy" ? (
            <p className="text-[11px] text-muted-foreground">
              Applied by a monitoring policy (profile or template). Change its
              scope, frequency, and checks on{" "}
              <Link
                to="/monitoring"
                search={{ view: "configuration", status: "all" }}
                className="link"
              >
                Monitoring → Configuration
              </Link>
              .
            </p>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              Inherited from a prefix check. Edit its schedule, interval, and
              exclusions on the{" "}
              {check.prefix_id ? (
                <Link
                  to="/prefixes/$id"
                  params={{ id: check.prefix_id }}
                  className="link"
                >
                  parent prefix
                </Link>
              ) : (
                "parent prefix"
              )}
              .
            </p>
          )}
          <LatencyChart ipId={ipId} templateId={check.template_id} />
          <CheckHistory ipId={ipId} templateId={check.template_id} />
        </div>
      )}
    </div>
  )
}

const SCHEDULE_OPTIONS: { value: ScheduleMode; label: string }[] = [
  { value: "follow_global", label: "Follow global" },
  { value: "custom_on", label: "Always on" },
  { value: "custom_off", label: "Off" },
]

function OverridePanel({
  ipId,
  check,
}: {
  ipId: string
  check: EffectiveCheck
}) {
  const qc = useQueryClient()
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api(`/api/monitoring/assignments/${check.assignment_id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["ip-checks", ipId] }),
    onError: (err) => apiErrorToast(err),
  })
  const setOverride = (
    key: "interval_seconds" | "rise" | "fall",
    value: number | null
  ) => {
    const next: AssignmentOverrides = { ...check.overrides }
    if (value == null) delete next[key]
    else next[key] = value
    patch.mutate({ overrides: next })
  }
  const td = check.template_defaults

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[12px]">
          <Checkbox
            checked={check.enabled}
            onCheckedChange={(v) => patch.mutate({ enabled: !!v })}
          />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-[12px] text-muted-foreground">
          Schedule
          <Select
            value={check.schedule_mode ?? "custom_on"}
            onValueChange={(v) =>
              patch.mutate({ schedule_mode: v as ScheduleMode })
            }
          >
            <SelectTrigger className="h-7 w-32 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULE_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <OverrideNumber
          label="Interval (s)"
          placeholder={td.interval_seconds}
          value={check.overrides.interval_seconds}
          onCommit={(v) => setOverride("interval_seconds", v)}
        />
        <OverrideNumber
          label="Rise"
          placeholder={td.rise}
          value={check.overrides.rise}
          onCommit={(v) => setOverride("rise", v)}
        />
        <OverrideNumber
          label="Fall"
          placeholder={td.fall}
          value={check.overrides.fall}
          onCommit={(v) => setOverride("fall", v)}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Blank = inherit the template default.
      </p>
    </div>
  )
}

function OverrideNumber({
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
        onBlur={() =>
          onCommit(draft.trim() === "" ? null : Number(draft.trim()))
        }
        className="h-8 text-[13px]"
      />
    </label>
  )
}
