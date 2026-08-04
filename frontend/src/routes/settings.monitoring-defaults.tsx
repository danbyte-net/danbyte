import { createFileRoute, Link } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FormCheckbox, FormSelect } from "@/components/forms"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"

export const Route = createFileRoute("/settings/monitoring-defaults")({
  component: MonitoringDefaultsPage,
})

function MonitoringDefaultsPage() {
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage deployment settings.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="Monitoring defaults">
        Deployment-wide scheduling for config-drift runs and the email digest.
        Tenants can override these.
      </SettingsHeader>
      <SettingsGrid>
        <ConfigDriftCard />
        <EmailDigestCard />
      </SettingsGrid>
    </div>
  )
}

function ConfigDriftCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [enabled, setEnabled] = useState(false)
  const [interval, setInterval] = useState<string | null>(null)

  useEffect(() => {
    if (data) {
      setEnabled(data.config_drift_enabled)
      setInterval(String(data.config_drift_interval_minutes))
    }
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Config drift"
      description={
        <>
          Danbyte dispatches a drift run to your enabled automation targets on
          this interval. Configure a target under{" "}
          <Link to="/automation-targets" className="underline">
            Integrations
          </Link>
          .
        </>
      }
      onSave={() =>
        save.mutate({
          key: "drift",
          patch: {
            config_drift_enabled: enabled,
            config_drift_interval_minutes: Math.min(
              10080,
              Math.max(1, Number(interval) || 60)
            ),
          },
        })
      }
      dirty={
        enabled !== data.config_drift_enabled ||
        interval !== String(data.config_drift_interval_minutes)
      }
      saving={savingKey === "drift"}
      saveLabel="Save config drift"
      footer={
        data.config_drift_last_run ? (
          <span className="text-[11px] text-muted-foreground">
            Last run:{" "}
            <span className="num font-mono">
              {new Date(data.config_drift_last_run).toLocaleString()}
            </span>
          </span>
        ) : undefined
      }
    >
      <FormCheckbox
        label="Schedule config-drift checks"
        checked={enabled}
        onChange={setEnabled}
        hint="Periodically compare device configuration against the expected baseline."
      />
      {enabled && (
        <Field
          label="Run every N minutes"
          hint="How often to dispatch a drift run (1–10080)."
        >
          <Input
            type="number"
            min={1}
            max={10080}
            value={interval ?? ""}
            onChange={(e) => setInterval(e.target.value)}
            className="w-40"
          />
        </Field>
      )}
    </SettingsCard>
  )
}

function EmailDigestCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [enabled, setEnabled] = useState(false)
  const [frequency, setFrequency] = useState("weekly")
  const [weekday, setWeekday] = useState("0")
  const [recipients, setRecipients] = useState("")
  const [certEnabled, setCertEnabled] = useState(false)
  const [certRecipients, setCertRecipients] = useState("")

  useEffect(() => {
    if (data) {
      setEnabled(data.digest_enabled)
      setFrequency(data.digest_frequency)
      setWeekday(String(data.digest_weekday))
      setRecipients(data.digest_recipients)
      setCertEnabled(data.cert_digest_enabled)
      setCertRecipients(data.cert_digest_recipients)
    }
  }, [data])

  const testDigest = useMutation({
    mutationFn: () =>
      api("/api/tenant-settings/digest/test/", { method: "POST", body: "{}" }),
    onSuccess: () => toast.success("Test digest sent for the active tenant."),
    onError: (e) => apiErrorToast(e),
  })

  if (!data) return null
  return (
    <SettingsCard
      title="Email digest"
      description="Email a periodic monitoring/status summary (up/down, alerts, recent changes) to a recipient list. Deployment-wide default; a tenant can override it."
      onSave={() =>
        save.mutate({
          key: "digest",
          patch: {
            digest_enabled: enabled,
            digest_frequency: frequency as "daily" | "weekly",
            digest_weekday: Math.max(0, Math.min(6, Number(weekday) || 0)),
            digest_recipients: recipients,
            cert_digest_enabled: certEnabled,
            cert_digest_recipients: certRecipients,
          },
        })
      }
      dirty={
        enabled !== data.digest_enabled ||
        frequency !== data.digest_frequency ||
        weekday !== String(data.digest_weekday) ||
        recipients !== data.digest_recipients ||
        certEnabled !== data.cert_digest_enabled ||
        certRecipients !== data.cert_digest_recipients
      }
      saving={savingKey === "digest"}
      saveLabel="Save digest"
    >
      <FormCheckbox
        label="Send an email digest"
        checked={enabled}
        onChange={setEnabled}
        hint="A scheduled summary email — daily, or weekly on a chosen day."
      />
      {enabled && (
        <>
          <FormSelect
            label="Frequency"
            value={frequency}
            onChange={(v) => v && setFrequency(v)}
            options={[
              { value: "daily", label: "Daily" },
              { value: "weekly", label: "Weekly" },
            ]}
          />
          {frequency === "weekly" && (
            <FormSelect
              label="Day of week"
              value={weekday}
              onChange={(v) => v && setWeekday(v)}
              options={[
                { value: "0", label: "Monday" },
                { value: "1", label: "Tuesday" },
                { value: "2", label: "Wednesday" },
                { value: "3", label: "Thursday" },
                { value: "4", label: "Friday" },
                { value: "5", label: "Saturday" },
                { value: "6", label: "Sunday" },
              ]}
            />
          )}
          <Field
            label="Recipients"
            hint="Comma- or newline-separated email addresses."
          >
            <textarea
              className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder="ops@example.com, oncall@example.com"
            />
          </Field>
          <div>
            <Button
              variant="outline"
              size="sm"
              disabled={testDigest.isPending}
              onClick={() => testDigest.mutate()}
            >
              {testDigest.isPending ? "Sending…" : "Send test digest"}
            </Button>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Sends the active tenant's digest now to the recipients above.
            </p>
          </div>
        </>
      )}

      <div className="mt-2 border-t border-border pt-4">
        <FormCheckbox
          label="Certificate digest (separate email)"
          checked={certEnabled}
          onChange={setCertEnabled}
          hint="A dedicated certificate-expiry summary, sent on the same schedule but as its own email. Immediate expiry alerts still fire through notification channels."
        />
        {certEnabled && (
          <Field
            label="Certificate-digest recipients"
            hint="Blank uses the digest recipients above."
            className="mt-3"
          >
            <textarea
              className="min-h-16 w-full rounded-md border border-border bg-transparent px-3 py-2 text-sm"
              value={certRecipients}
              onChange={(e) => setCertRecipients(e.target.value)}
              placeholder="security@example.com"
            />
          </Field>
        )}
      </div>
    </SettingsCard>
  )
}
