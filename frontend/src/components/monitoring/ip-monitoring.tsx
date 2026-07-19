import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Activity, Play, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AssignmentOverrides,
  type CheckNowResponse,
  type CheckStatus,
  type EffectiveCheck,
  type IpChecksResponse,
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
import { Sparkline } from "./sparkline"
import { AddCheckDialog } from "./add-check-dialog"
import { CheckHistory } from "./check-history"
import { UptimePanel } from "./uptime-panel"
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

  const checkNow = useMutation({
    mutationFn: () =>
      api<CheckNowResponse>(`/api/monitoring/ips/${ip.id}/check-now/`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      const up = data.results.filter((r) => r.status === "up").length
      toast.success(
        `Ran ${data.count} check${data.count === 1 ? "" : "s"} — ${up} up`
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

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-foreground uppercase">
          <Activity className="h-3.5 w-3.5 text-muted-foreground" />
          Monitoring
        </h2>
        {checks.length > 0 && <MixedStatusBadge counts={counts} />}
        <div className="ml-auto flex items-center gap-3">
          <label
            className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
            title="Exclude this IP from the 'flapping a lot' monitor — for a known noisy host."
          >
            <Checkbox
              checked={flapExclude}
              onCheckedChange={(v) => {
                setFlapExclude(!!v)
                flapM.mutate(!!v)
              }}
            />
            Ignore flapping
          </label>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => checkNow.mutate()}
              disabled={checkNow.isPending || checks.length === 0}
            >
              <Play className="h-3.5 w-3.5" />
              {checkNow.isPending ? "Checking…" : "Check now"}
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add check
            </Button>
          </div>
        </div>
      </div>

      {checks.length > 0 && <UptimePanel ipId={ip.id} />}

      <div className="overflow-hidden rounded-lg border border-border">
        {q.isLoading && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
        )}
        {q.data && checks.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No checks on this IP yet. Add one to start monitoring its
            reachability.
          </p>
        )}
        {checks.map((c, i) => (
          <CheckRow
            key={c.template_id}
            ipId={ip.id}
            check={c}
            striped={i % 2 === 1}
            expanded={expanded === c.template_id}
            onToggle={() =>
              setExpanded(expanded === c.template_id ? null : c.template_id)
            }
          />
        ))}
      </div>

      <AddCheckDialog
        target={{ kind: "ip", id: ip.id, label: ip.ip_address }}
        open={adding}
        onOpenChange={setAdding}
      />
    </section>
  )
}

function CheckRow({
  ipId,
  check,
  striped,
  expanded,
  onToggle,
}: {
  ipId: string
  check: EffectiveCheck
  striped: boolean
  expanded: boolean
  onToggle: () => void
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
    <div className={striped ? "bg-muted/30" : undefined}>
      <div className="flex items-center gap-3 px-3 py-2 text-[13px]">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <CheckStatusBadge status={status} />
          <span className="font-medium">{check.template_name}</span>
          <span className="font-mono text-[11px] text-muted-foreground uppercase">
            {check.kind}
          </span>
          {check.source === "inherited" && (
            <Badge variant="outline" className="h-4 px-1.5 text-[10px]">
              inherited
            </Badge>
          )}
          {check.source === "policy" && (
            <Badge
              variant="outline"
              className="h-4 px-1.5 text-[10px]"
              title="Applied by a Monitoring → Configuration policy"
            >
              from policy
            </Badge>
          )}
        </button>
        <Sparkline points={check.sparkline} />
        <span className="num w-20 text-right text-xs text-muted-foreground">
          {latency != null ? `${latency.toFixed(1)} ms` : "—"}
        </span>
        <span className="w-28 text-right text-[11px] text-muted-foreground">
          {check.state?.last_checked
            ? new Date(check.state.last_checked).toLocaleTimeString()
            : "never run"}
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
          {check.source === "direct" ? (
            <OverridePanel ipId={ipId} check={check} />
          ) : check.source === "policy" ? (
            <p className="text-[11px] text-muted-foreground">
              Applied by a monitoring policy (profile or template). Change its
              scope, frequency, and checks on{" "}
              <Link
                to="/monitoring"
                search={{ view: "configuration", status: "all" }}
                className="underline underline-offset-2"
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
                  className="underline underline-offset-2"
                >
                  parent prefix
                </Link>
              ) : (
                "parent prefix"
              )}
              .
            </p>
          )}
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
    <div className="space-y-3 rounded-md border border-border/60 p-3">
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
