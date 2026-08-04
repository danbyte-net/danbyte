import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ChannelKind,
  type CheckStatus,
  type MinSeverity,
  type NotificationChannel,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormSelect } from "@/components/forms"
import { PrefixPicker } from "@/components/prefix-picker"
import { DevicePicker } from "@/components/device-picker"
import { CHANNEL_KINDS } from "./channels-list"
import { apiErrorToast } from "@/lib/api-toast"

const TRIGGER_STATUSES: CheckStatus[] = ["down", "stale", "degraded"]
const SEVERITIES: { value: MinSeverity; label: string }[] = [
  { value: "info", label: "Info and up (everything)" },
  { value: "warning", label: "Warning and up" },
  { value: "critical", label: "Critical only" },
]

const URL_KINDS: ChannelKind[] = ["slack", "teams", "discord", "webhook"]

export function ChannelForm({
  channel,
  onSaved,
  onCancel,
}: {
  channel?: NotificationChannel
  onSaved: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!channel
  const cfg = (channel?.config ?? {}) as Record<string, unknown>

  const [name, setName] = useState(channel?.name ?? "")
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "slack")
  const [minSeverity, setMinSeverity] = useState<MinSeverity>(
    channel?.min_severity ?? "warning"
  )
  const [enabled, setEnabled] = useState(channel?.enabled ?? true)
  const [statuses, setStatuses] = useState<CheckStatus[]>(
    channel?.on_statuses ?? []
  )
  const [url, setUrl] = useState(String(cfg.url ?? ""))
  const [routingKey, setRoutingKey] = useState(String(cfg.routing_key ?? ""))
  const [recipients, setRecipients] = useState(
    Array.isArray(cfg.recipients) ? (cfg.recipients as string[]).join("\n") : ""
  )
  const [sendStatusChanges, setSendStatusChanges] = useState(
    channel?.send_status_changes ?? false
  )
  const [statusMode, setStatusMode] = useState<"instant" | "batched">(
    channel?.status_change_mode ?? "batched"
  )
  const [statusInterval, setStatusInterval] = useState(
    String(channel?.status_change_interval_minutes ?? 30)
  )
  const [matchPrefix, setMatchPrefix] = useState<string | null>(
    channel?.match_prefix ?? null
  )
  const [matchDevice, setMatchDevice] = useState<string | null>(
    channel?.match_device ?? null
  )
  const [scopeKind, setScopeKind] = useState<"all" | "prefix" | "device">(
    channel?.match_device ? "device" : channel?.match_prefix ? "prefix" : "all"
  )

  const buildConfig = (): Record<string, unknown> => {
    if (URL_KINDS.includes(kind)) return { url: url.trim() }
    if (kind === "pagerduty") return { routing_key: routingKey.trim() }
    if (kind === "email")
      return {
        recipients: recipients
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter(Boolean),
      }
    return {}
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        kind,
        enabled,
        min_severity: minSeverity,
        on_statuses: statuses,
        config: buildConfig(),
        send_status_changes: sendStatusChanges,
        status_change_mode: statusMode,
        status_change_interval_minutes: Number(statusInterval) || 30,
        match_prefix: scopeKind === "prefix" ? matchPrefix : null,
        match_device: scopeKind === "device" ? matchDevice : null,
      }
      return isEdit
        ? api(`/api/monitoring/channels/${channel!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/monitoring/channels/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["channels"] })
      toast.success(isEdit ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      onSaved()
    },
    onError: (err) => apiErrorToast(err),
  })

  const toggle = (v: CheckStatus) =>
    setStatuses((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) save.mutate()
      }}
      className="grid max-w-2xl gap-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ops Slack"
            autoFocus
            required
          />
        </Field>
        <FormSelect
          label="Transport"
          value={kind}
          onChange={(v) => setKind((v as ChannelKind) ?? "slack")}
          options={CHANNEL_KINDS}
        />
      </div>

      {URL_KINDS.includes(kind) && (
        <Field
          label="Webhook URL"
          hint={
            kind === "slack"
              ? "Slack incoming-webhook URL"
              : kind === "teams"
                ? "Teams incoming-webhook URL"
                : kind === "discord"
                  ? "Discord webhook URL"
                  : "HTTP endpoint to POST the alert JSON to"
          }
        >
          <Input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://hooks…"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}

      {kind === "pagerduty" && (
        <Field
          label="Routing key"
          hint="PagerDuty Events API v2 integration key"
        >
          <Input
            value={routingKey}
            onChange={(e) => setRoutingKey(e.target.value)}
            placeholder="R0123456789ABCDEF…"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}

      {kind === "email" && (
        <Field
          label="Recipients"
          hint="One address per line (or comma-separated)"
        >
          <Textarea
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="oncall@acme.com&#10;noc@acme.com"
            className="min-h-20 font-mono text-[13px]"
            required
          />
        </Field>
      )}

      <FormSelect
        label="Minimum severity"
        hint="Alerts below this severity are not sent to this channel."
        value={minSeverity}
        onChange={(v) => setMinSeverity((v as MinSeverity) ?? "warning")}
        options={SEVERITIES}
      />

      <Field
        label="Only these statuses"
        hint="Leave all unticked to send for any bad status."
      >
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {TRIGGER_STATUSES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-[13px]">
              <Checkbox
                checked={statuses.includes(s)}
                onCheckedChange={() => toggle(s)}
              />
              {s}
            </label>
          ))}
        </div>
      </Field>

      <div className="grid gap-4 border-t border-border pt-4">
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={sendStatusChanges}
            onCheckedChange={(v) => setSendStatusChanges(!!v)}
            className="mt-0.5"
          />
          <span>
            Send raw status changes
            <span className="block text-[12px] text-muted-foreground">
              Email/post every status change for matching IPs, independent of
              alert rules.
            </span>
          </span>
        </label>
        {sendStatusChanges && (
          <div className="grid gap-4 pl-6">
            <FormSelect
              label="Delivery"
              value={statusMode}
              onChange={(v) =>
                setStatusMode((v as "instant" | "batched") ?? "batched")
              }
              options={[
                { value: "instant", label: "Instant (per check batch)" },
                {
                  value: "batched",
                  label: "Batched — a periodic mini-digest",
                },
              ]}
            />
            {statusMode === "batched" && (
              <Field
                label="Digest interval (minutes)"
                hint="How often to summarize and send the mini-digest."
              >
                <Input
                  type="number"
                  min={1}
                  value={statusInterval}
                  onChange={(e) => setStatusInterval(e.target.value)}
                  className="w-32 font-mono text-[13px]"
                />
              </Field>
            )}
            <FormSelect
              label="Scope"
              value={scopeKind}
              onChange={(v) =>
                setScopeKind((v as "all" | "prefix" | "device") ?? "all")
              }
              options={[
                { value: "all", label: "Everything" },
                { value: "prefix", label: "Only a subnet" },
                { value: "device", label: "Only a device" },
              ]}
            />
            {scopeKind === "prefix" && (
              <PrefixPicker
                label="Subnet"
                value={matchPrefix}
                onChange={setMatchPrefix}
              />
            )}
            {scopeKind === "device" && (
              <DevicePicker
                label="Device"
                value={matchDevice}
                onChange={setMatchDevice}
              />
            )}
            <p className="text-[12px] text-muted-foreground">
              The status filter above also applies here — leave it unticked to
              notify on every change.
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => setEnabled(!!v)}
          />
          Enabled
        </label>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={save.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          {save.isPending
            ? "Saving…"
            : isEdit
              ? "Save channel"
              : "Create channel"}
        </Button>
      </div>
    </form>
  )
}
