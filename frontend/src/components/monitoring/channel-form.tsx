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
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FormCheckbox,
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  type SelectOption,
} from "@/components/forms"
import { PrefixPicker } from "@/components/prefix-picker"
import { DevicePicker } from "@/components/device-picker"
import { CheckStatusBadge } from "./status-badge"
import { CHANNEL_KINDS } from "./channels-list"
import { apiErrorToast } from "@/lib/api-toast"

const TRIGGER_STATUSES: CheckStatus[] = ["down", "stale", "degraded"]

// The channels table tints min-severity with these variants; the picker shows
// the same pill so the two never disagree.
const SEV_VARIANT: Record<
  MinSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

const SEVERITIES: SelectOption[] = (
  [
    { value: "info", label: "Info and up (everything)" },
    { value: "warning", label: "Warning and up" },
    { value: "critical", label: "Critical only" },
  ] as { value: MinSeverity; label: string }[]
).map((s) => ({
  value: s.value,
  label: (
    <span className="flex items-center gap-2">
      <Badge variant={SEV_VARIANT[s.value]} className="capitalize">
        {s.value}
      </Badge>
      <span className="text-muted-foreground">{s.label}</span>
    </span>
  ),
}))

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
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Channel" card>
            <FormText
              label="Name"
              required
              autoFocus
              value={name}
              onChange={setName}
              placeholder="Ops Slack"
            />

            <FormSelect
              label="Transport"
              required
              value={kind}
              onChange={(v) => setKind((v as ChannelKind) ?? "slack")}
              options={CHANNEL_KINDS}
            />

            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSection>

          <FormSection title="Delivery target" card>
            {URL_KINDS.includes(kind) && (
              <FormText
                label="Webhook URL"
                required
                type="url"
                mono
                value={url}
                onChange={setUrl}
                placeholder="https://hooks…"
                hint={
                  kind === "slack"
                    ? "Slack incoming-webhook URL"
                    : kind === "teams"
                      ? "Teams incoming-webhook URL"
                      : kind === "discord"
                        ? "Discord webhook URL"
                        : "HTTP endpoint to POST the alert JSON to"
                }
              />
            )}

            {kind === "pagerduty" && (
              <FormText
                label="Routing key"
                required
                mono
                value={routingKey}
                onChange={setRoutingKey}
                placeholder="R0123456789ABCDEF…"
                hint="PagerDuty Events API v2 integration key"
              />
            )}

            {kind === "email" && (
              // Shared Field + Textarea rather than FormTextarea: the native
              // `required` guard is part of this form's behaviour and
              // FormTextarea does not forward it.
              <Field
                label="Recipients"
                required
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
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Alert filtering" card>
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
                  <label
                    key={s}
                    className="flex items-center gap-2 text-[13px]"
                  >
                    <Checkbox
                      checked={statuses.includes(s)}
                      onCheckedChange={() => toggle(s)}
                    />
                    <CheckStatusBadge status={s} />
                  </label>
                ))}
              </div>
            </Field>
          </FormSection>

          <FormSection title="Status changes" card>
            <FormCheckbox
              label="Send raw status changes"
              hint="Email/post every status change for matching IPs, independent of alert rules."
              checked={sendStatusChanges}
              onChange={setSendStatusChanges}
            />

            {sendStatusChanges && (
              <div className="grid gap-3 pl-6">
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
                      label: "Batched - a periodic mini-digest",
                    },
                  ]}
                />
                {statusMode === "batched" && (
                  <FormText
                    label="Digest interval"
                    type="number"
                    mono
                    min={1}
                    value={statusInterval}
                    onChange={setStatusInterval}
                    hint="Minutes between mini-digests."
                    inputClassName="w-32"
                  />
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
                  The status filter also applies here - leave it unticked to
                  notify on every change.
                </p>
              </div>
            )}
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save channel" : "Create channel"}
      />
    </form>
  )
}
