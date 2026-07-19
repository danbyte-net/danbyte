import { useEffect, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type MonitoringSettings, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { INTERVALS } from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

// Named cadence options (minutes) for the discovery interval picker.
const MINUTE_INTERVALS = [
  { value: "5", label: "5 minutes" },
  { value: "15", label: "15 minutes" },
  { value: "30", label: "30 minutes" },
  { value: "60", label: "Hourly" },
  { value: "360", label: "6 hours" },
  { value: "720", label: "12 hours" },
  { value: "1440", label: "Daily" },
]

interface IpStatus {
  id: string
  name: string
  color: string
  text_color: string
}

export function MonitoringSettingsForm() {
  const qc = useQueryClient()
  const settingsQ = useQuery({
    queryKey: ["monitoring-settings"],
    queryFn: () => api<MonitoringSettings>("/api/monitoring/settings/"),
  })
  const statusesQ = useQuery({
    queryKey: ["statuses-all"],
    queryFn: () => api<Paginated<IpStatus>>("/api/statuses/"),
    staleTime: 5 * 60_000,
  })

  const [draft, setDraft] = useState<MonitoringSettings | null>(null)
  useEffect(() => {
    if (settingsQ.data) setDraft(settingsQ.data)
  }, [settingsQ.data])

  const save = useMutation({
    mutationFn: (body: Partial<MonitoringSettings>) =>
      api<MonitoringSettings>("/api/monitoring/settings/", {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["monitoring-settings"], data)
      qc.invalidateQueries({ queryKey: ["monitoring-stats"] })
      toast.success("Monitoring settings saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (!draft)
    return <p className="text-sm text-muted-foreground">Loading settings…</p>

  const set = <K extends keyof MonitoringSettings>(
    k: K,
    v: MonitoringSettings[K]
  ) => setDraft({ ...draft, [k]: v })

  const toggleSkip = (id: string) => {
    const has = draft.skip_ip_statuses.includes(id)
    set(
      "skip_ip_statuses",
      has
        ? draft.skip_ip_statuses.filter((x) => x !== id)
        : [...draft.skip_ip_statuses, id]
    )
  }

  const toggleFlapExclude = (id: string) => {
    const has = draft.flap_exclude_ip_statuses.includes(id)
    set(
      "flap_exclude_ip_statuses",
      has
        ? draft.flap_exclude_ip_statuses.filter((x) => x !== id)
        : [...draft.flap_exclude_ip_statuses, id]
    )
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          global_enabled: draft.global_enabled,
          default_interval_seconds: Number(draft.default_interval_seconds),
          stale_after_scans: Number(draft.stale_after_scans),
          stale_after_days: Number(draft.stale_after_days),
          skip_ip_statuses: draft.skip_ip_statuses,
          dns_sync_enabled: draft.dns_sync_enabled,
          dns_clear_on_missing: draft.dns_clear_on_missing,
          dns_preserve_if_alive: draft.dns_preserve_if_alive,
          renotify_enabled: draft.renotify_enabled,
          renotify_interval_minutes: Number(draft.renotify_interval_minutes),
          escalate_enabled: draft.escalate_enabled,
          escalate_after_minutes: Number(draft.escalate_after_minutes),
          flap_threshold: Number(draft.flap_threshold),
          flap_window_minutes: Number(draft.flap_window_minutes),
          group_notifications: draft.group_notifications,
          group_threshold: Number(draft.group_threshold),
          discovery_enabled: draft.discovery_enabled,
          discovery_min_prefix_length: Number(
            draft.discovery_min_prefix_length
          ),
          discovery_interval_minutes: Number(draft.discovery_interval_minutes),
          discovery_all_prefixes: draft.discovery_all_prefixes,
          cleanup_enabled: draft.cleanup_enabled,
          cleanup_after_days: Number(draft.cleanup_after_days),
          flap_exclude_ip_statuses: draft.flap_exclude_ip_statuses,
        })
      }}
    >
      {/* Masonry: the groups pack into balanced columns instead of one narrow
          stack, so a wide screen isn't ~70% empty. */}
      <div className="columns-1 gap-4 xl:columns-2 [&>*]:mb-4 [&>*]:break-inside-avoid">
        <Section title="Schedule">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.global_enabled}
              onCheckedChange={(v) => set("global_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">
                Global schedule enabled
              </span>
              <span className="text-[11px] text-muted-foreground">
                Master switch that “Follow global” checks obey.
              </span>
            </span>
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <IntervalSelect
              label="Default check interval"
              hint="New checks inherit this cadence"
              value={draft.default_interval_seconds}
              onChange={(v) => set("default_interval_seconds", v)}
            />
            <NumberField
              label="Stale after N scans"
              hint="Down this many checks → stale (0 = off)"
              value={draft.stale_after_scans}
              onChange={(v) => set("stale_after_scans", v)}
            />
            <NumberField
              label="Stale after N days"
              hint="Down this long → stale (0 = off)"
              value={draft.stale_after_days}
              onChange={(v) => set("stale_after_days", v)}
            />
          </div>
        </Section>

        <Section
          title="Skip these IP statuses"
          hint={
            <>
              IPs whose status is ticked are not checked — they show as{" "}
              <span className="font-medium">Skipped</span>.
            </>
          }
        >
          <div className="flex flex-wrap gap-x-5 gap-y-1.5">
            {(statusesQ.data?.results ?? []).map((s) => (
              <label key={s.id} className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  checked={draft.skip_ip_statuses.includes(s.id)}
                  onCheckedChange={() => toggleSkip(s.id)}
                />
                <span>{s.name}</span>
              </label>
            ))}
            {statusesQ.data && statusesQ.data.results.length === 0 && (
              <span className="text-[13px] text-muted-foreground">
                No IP statuses defined yet.
              </span>
            )}
          </div>
        </Section>

        <Section title="Reverse DNS">
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.dns_sync_enabled}
              onCheckedChange={(v) => set("dns_sync_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Sync reverse DNS</span>
              <span className="text-[11px] text-muted-foreground">
                Resolve each monitored IP's PTR and store it as the IP's DNS
                name.
              </span>
            </span>
          </label>
          {draft.dns_sync_enabled && (
            <div className="ml-6 space-y-2">
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={draft.dns_preserve_if_alive}
                  onCheckedChange={(v) => set("dns_preserve_if_alive", !!v)}
                  className="mt-0.5"
                />
                <span className="text-[13px]">
                  Keep the existing name when a lookup fails but the IP is up
                </span>
              </label>
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={draft.dns_clear_on_missing}
                  onCheckedChange={(v) => set("dns_clear_on_missing", !!v)}
                  className="mt-0.5"
                />
                <span className="text-[13px]">
                  Clear the DNS name when the lookup returns nothing
                </span>
              </label>
            </div>
          )}
        </Section>

        <Section title="Alerting">
          {/* Grouping */}
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.group_notifications}
              onCheckedChange={(v) => set("group_notifications", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Group alert bursts</span>
              <span className="text-[11px] text-muted-foreground">
                When one scan opens many alerts (e.g. a switch dies), send one
                digest per channel instead of a storm.
              </span>
            </span>
          </label>
          {draft.group_notifications && (
            <div className="ml-6 max-w-xs">
              <NumberField
                label="Group threshold"
                hint="New alerts in a batch before grouping"
                value={draft.group_threshold}
                onChange={(v) => set("group_threshold", v)}
              />
            </div>
          )}

          {/* Renotify */}
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.renotify_enabled}
              onCheckedChange={(v) => set("renotify_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">
                Renotify firing alerts
              </span>
              <span className="text-[11px] text-muted-foreground">
                Re-send a reminder for alerts still firing and unacknowledged.
                Acknowledging or silencing one stops its reminders.
              </span>
            </span>
          </label>
          {draft.renotify_enabled && (
            <div className="ml-6 max-w-xs">
              <NumberField
                label="Renotify every (min)"
                value={draft.renotify_interval_minutes}
                onChange={(v) => set("renotify_interval_minutes", v)}
              />
            </div>
          )}

          {/* Escalation */}
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.escalate_enabled}
              onCheckedChange={(v) => set("escalate_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Escalate stale alerts</span>
              <span className="text-[11px] text-muted-foreground">
                Bump an alert to <span className="font-medium">critical</span>{" "}
                if it stays firing and unacknowledged too long.
              </span>
            </span>
          </label>
          {draft.escalate_enabled && (
            <div className="ml-6 max-w-xs">
              <NumberField
                label="Escalate after (min)"
                value={draft.escalate_after_minutes}
                onChange={(v) => set("escalate_after_minutes", v)}
              />
            </div>
          )}

          {/* Flap dampening */}
          <div className="space-y-2">
            <div className="flex flex-col">
              <span className="text-sm font-medium">Flap dampening</span>
              <span className="text-[11px] text-muted-foreground">
                A check that keeps bouncing (down → up → down…) would otherwise
                re-alert on every flip. When the same alert reopens{" "}
                <span className="font-medium">
                  {draft.flap_threshold || 5}+
                </span>{" "}
                times within{" "}
                <span className="font-medium">
                  {draft.flap_window_minutes || 30}
                </span>{" "}
                minutes, Danbyte tags it{" "}
                <span className="font-medium">flapping</span> and pauses its
                reminders until it settles. Set the threshold to 0 to disable.
              </span>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <NumberField
                label="Flap threshold"
                hint="Reopens before flagging (0 = off)"
                value={draft.flap_threshold}
                onChange={(v) => set("flap_threshold", v)}
              />
              <NumberField
                label="Flap window (min)"
                hint="Window the reopens are counted over"
                value={draft.flap_window_minutes}
                onChange={(v) => set("flap_window_minutes", v)}
              />
            </div>

            {/* Flapping-monitor exclusions */}
            <div className="space-y-1.5 pt-1">
              <Label className="text-[11px] tracking-wide text-muted-foreground uppercase">
                Exclude statuses from the flapping monitor
              </Label>
              <p className="text-[11px] text-muted-foreground">
                IPs with a ticked status are never surfaced as flapping — handy
                for <span className="font-medium">DHCP scopes</span> and other
                expected-churn ranges. (Exclude a single IP from its Monitoring
                tab.)
              </p>
              <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                {(statusesQ.data?.results ?? []).map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <Checkbox
                      checked={draft.flap_exclude_ip_statuses.includes(s.id)}
                      onCheckedChange={() => toggleFlapExclude(s.id)}
                    />
                    <span>{s.name}</span>
                  </label>
                ))}
                {statusesQ.data && statusesQ.data.results.length === 0 && (
                  <span className="text-[13px] text-muted-foreground">
                    No IP statuses defined yet.
                  </span>
                )}
              </div>
            </div>
          </div>
        </Section>

        <Section
          title="Discovery & cleanup"
          hint="Opt-in subnet lifecycle. Turn on discovery per prefix from its Monitoring tab; these are the deployment-wide switches."
        >
          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.discovery_enabled}
              onCheckedChange={(v) => set("discovery_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Subnet discovery</span>
              <span className="text-[11px] text-muted-foreground">
                Periodically ICMP-sweep prefixes flagged{" "}
                <span className="font-medium">auto-discover</span> and create
                IPs for responders not yet recorded.
              </span>
            </span>
          </label>
          {draft.discovery_enabled && (
            <div className="ml-6 space-y-3">
              <label className="flex items-start gap-2">
                <Checkbox
                  checked={draft.discovery_all_prefixes}
                  onCheckedChange={(v) => set("discovery_all_prefixes", !!v)}
                  className="mt-0.5"
                />
                <span className="flex flex-col">
                  <span className="text-sm font-medium">
                    Auto-discover all prefixes
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Sweep every prefix by default — no per-prefix toggle needed.
                    Off: only prefixes you flag{" "}
                    <span className="font-medium">auto-discover</span> (and
                    their child prefixes) are swept.
                  </span>
                </span>
              </label>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <MinuteIntervalSelect
                  label="Discover interval"
                  hint="How often each prefix is swept"
                  value={draft.discovery_interval_minutes}
                  onChange={(v) => set("discovery_interval_minutes", v)}
                />
                <NumberField
                  label="Smallest prefix length"
                  hint="Largest subnet to sweep (e.g. 22 = /22)"
                  value={draft.discovery_min_prefix_length}
                  onChange={(v) => set("discovery_min_prefix_length", v)}
                />
              </div>
            </div>
          )}

          <label className="flex items-start gap-2">
            <Checkbox
              checked={draft.cleanup_enabled}
              onCheckedChange={(v) => set("cleanup_enabled", !!v)}
              className="mt-0.5"
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium">Stale auto-cleanup</span>
              <span className="text-[11px] text-muted-foreground">
                Delete <span className="font-medium">discovered</span> IPs
                unreachable past the grace period. User-created IPs are never
                touched.
              </span>
            </span>
          </label>
          {draft.cleanup_enabled && (
            <div className="ml-6 max-w-xs">
              <NumberField
                label="Grace period (days)"
                hint="Unseen this long → removed"
                value={draft.cleanup_after_days}
                onChange={(v) => set("cleanup_after_days", v)}
              />
            </div>
          )}
        </Section>
      </div>

      {/* Sticky, and named: every group above is one settings object, so one
          save is honest — but it must say so and stay reachable rather than
          hiding at the bottom of a long page. */}
      <div className="sticky bottom-0 -mx-4 mt-4 flex items-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6">
        <span className="text-[11px] text-muted-foreground">
          Saves every monitoring group on this page.
        </span>
        <Button type="submit" className="ml-auto" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save monitoring settings"}
        </Button>
      </div>
    </form>
  )
}

/** One titled group. A card rather than a border-t divider, so the groups can
 * flow into a masonry grid and use the page width instead of stacking in one
 * narrow column. */
function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </header>
      <div className="space-y-3 p-4">{children}</div>
    </section>
  )
}

function NumberField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        min={0}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-8 text-sm"
      />
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

// A named-cadence picker over a numeric value, with a "Custom (N)" fallback so
// any value set elsewhere still round-trips.
function CadenceSelect({
  label,
  hint,
  value,
  unit,
  options,
  onChange,
}: {
  label: string
  hint?: string
  value: number
  unit: string
  options: { value: string; label: string }[]
  onChange: (v: number) => void
}) {
  const known = options.some((o) => o.value === String(value))
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
        <SelectTrigger className="h-8 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {!known && (
            <SelectItem value={String(value)}>
              Custom ({value} {unit})
            </SelectItem>
          )}
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hint && <p className="text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

function IntervalSelect(props: {
  label: string
  hint?: string
  value: number
  onChange: (v: number) => void
}) {
  return <CadenceSelect {...props} unit="s" options={INTERVALS} />
}

function MinuteIntervalSelect(props: {
  label: string
  hint?: string
  value: number
  onChange: (v: number) => void
}) {
  return <CadenceSelect {...props} unit="min" options={MINUTE_INTERVALS} />
}
