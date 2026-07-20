import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeploymentSettings } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/forms"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { SmtpFields } from "@/components/settings/smtp-fields"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/email")({
  component: EmailSettingsPage,
})

function EmailSettingsPage() {
  const { canManageDeployment, isLoading } = useMe()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["deployment-email"],
    queryFn: () => api<DeploymentSettings>("/api/deployment/email/"),
    enabled: canManageDeployment,
  })

  const [form, setForm] = useState<DeploymentSettings | null>(null)
  const [password, setPassword] = useState("")
  const [testTo, setTestTo] = useState("")
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<DeploymentSettings>("/api/deployment/email/", {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          ...(password ? { smtp_password: password } : {}),
        }),
      }),
    onSuccess: (data) => {
      setForm(data)
      setPassword("")
      qc.setQueryData(["deployment-email"], data)
      toast.success("Email & delivery settings saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; to?: string }>("/api/deployment/email/test/", {
        method: "POST",
        body: JSON.stringify({ to: testTo || undefined }),
      }),
    onSuccess: (r) => toast.success(`Test email sent to ${r.to}`),
    onError: (err) => apiErrorToast(err),
  })

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (!canManageDeployment) {
    return (
      <p className="text-sm text-muted-foreground">
        Deployment admin required — these settings apply to every tenant. Tenant
        email overrides live under{" "}
        <span className="font-mono">Settings → This tenant → Email</span>.
      </p>
    )
  }
  if (q.isError) return <QueryError error={q.error} />
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>

  const set = <K extends keyof DeploymentSettings>(
    key: K,
    value: DeploymentSettings[K]
  ) => setForm((f) => (f ? { ...f, [key]: value } : f))

  return (
    <div className="space-y-6">
      <SettingsHeader title="Email & Delivery">
        The deployment-wide mail server and outbound-delivery options. Each card
        saves on its own.
      </SettingsHeader>
      <SettingsGrid>
        <SettingsCard
          title="Email (SMTP)"
          description="The default mail server for the whole deployment. Tenants may override it with their own relay (Settings → This tenant → Email)."
        >
          <SmtpFields
            value={form}
            onChange={(k, v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
            password={password}
            onPasswordChange={setPassword}
          />
        </SettingsCard>

        <SettingsCard
          title="Outbound delivery"
          description="Applies to all transports (Slack, Teams, Discord, PagerDuty, webhook, email). Deployment-wide — never per-tenant."
        >
          <Field
            label="Public base URL"
            hint="Used to deep-link alerts inside notification messages."
          >
            <Input
              value={form.public_base_url}
              onChange={(e) => set("public_base_url", e.target.value)}
              placeholder="https://danbyte.acme.com"
              className="font-mono text-[13px]"
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Webhook timeout (s)">
              <Input
                type="number"
                value={form.webhook_timeout}
                onChange={(e) =>
                  set("webhook_timeout", Number(e.target.value) || 0)
                }
                className="font-mono text-[13px]"
              />
            </Field>
            <Field label="Outbound proxy" hint="optional">
              <Input
                value={form.outbound_proxy}
                onChange={(e) => set("outbound_proxy", e.target.value)}
                placeholder="http://proxy:3128"
                className="font-mono text-[13px]"
              />
            </Field>
          </div>
        </SettingsCard>

        <SettingsCard
          title="Send a test email"
          description="Verifies the SMTP config above. Save first if you just changed it."
        >
          <div className="flex items-end gap-2">
            <Field label="Recipient" className="flex-1">
              <Input
                type="email"
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@acme.com (defaults to your account email)"
                className="font-mono text-[13px]"
              />
            </Field>
            <Button
              type="button"
              variant="secondary"
              onClick={() => test.mutate()}
              disabled={test.isPending || !form.email_enabled}
            >
              {test.isPending ? "Sending…" : "Send test"}
            </Button>
          </div>
          {!form.email_enabled && (
            <p className="text-[11px] text-muted-foreground">
              Enable email delivery and save to send a test.
            </p>
          )}
        </SettingsCard>
      </SettingsGrid>

      {/* SMTP and delivery are ONE settings object, so one save is honest —
          per-card buttons that each quietly wrote both would be worse than the
          single button they replaced. It just has to say what it covers. */}
      <div className="sticky bottom-0 -mx-4 mt-4 flex items-center gap-2 border-t border-border bg-background/95 px-4 py-3 backdrop-blur lg:-mx-6 lg:px-6">
        <span className="text-[11px] text-muted-foreground">
          Saves SMTP + outbound delivery.
        </span>
        <Button
          className="ml-auto"
          onClick={() => save.mutate()}
          disabled={save.isPending}
        >
          {save.isPending ? "Saving…" : "Save email settings"}
        </Button>
      </div>
    </div>
  )
}
