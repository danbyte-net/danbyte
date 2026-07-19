import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type TenantSettings } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/forms"
import { OverrideCard } from "@/components/settings/override-card"
import { SmtpFields } from "@/components/settings/smtp-fields"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/tenant-email")({
  component: TenantEmailPage,
})

function TenantEmailPage() {
  const { canManage, isLoading } = useMe()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: () => api<TenantSettings>("/api/tenant-settings/"),
    enabled: canManage,
  })

  const [form, setForm] = useState<TenantSettings | null>(null)
  const [password, setPassword] = useState("")
  const [testTo, setTestTo] = useState("")
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<TenantSettings>("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify({
          override_email: form!.override_email,
          email_enabled: form!.email_enabled,
          smtp_host: form!.smtp_host,
          smtp_port: form!.smtp_port,
          smtp_security: form!.smtp_security,
          smtp_username: form!.smtp_username,
          email_from: form!.email_from,
          ...(password ? { smtp_password: password } : {}),
        }),
      }),
    onSuccess: (data) => {
      setForm(data)
      setPassword("")
      qc.setQueryData(["tenant-settings"], data)
      toast.success("Tenant email settings saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; to?: string; via?: string }>(
        "/api/tenant-settings/email/test/",
        { method: "POST", body: JSON.stringify({ to: testTo || undefined }) }
      ),
    onSuccess: (r) =>
      toast.success(
        `Test email sent to ${r.to} via the ${r.via === "tenant" ? "tenant relay" : "deployment relay"}`
      ),
    onError: (err) => apiErrorToast(err),
  })

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">Tenant admin required.</p>
    )
  if (q.isError) return <QueryError error={q.error} />
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>

  const dep = form.deployment_defaults
  const set = <K extends keyof TenantSettings>(
    key: K,
    value: TenantSettings[K]
  ) => setForm((f) => (f ? { ...f, [key]: value } : f))

  return (
    <div className="max-w-5xl space-y-6">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          save.mutate()
        }}
        className="space-y-6"
      >
        <OverrideCard
          title="Email (SMTP)"
          description="This tenant's alert and invite emails. Override to use a tenant-specific relay and From address."
          overridden={form.override_email}
          onOverriddenChange={(v) => set("override_email", v)}
          summary={
            dep.email_enabled ? (
              <span>
                Deployment relay{" "}
                <span className="font-mono text-[13px]">
                  {dep.smtp_host || "(env backend)"}
                </span>
                {dep.email_from && (
                  <>
                    {" "}
                    · from{" "}
                    <span className="font-mono text-[13px]">
                      {dep.email_from}
                    </span>
                  </>
                )}
              </span>
            ) : (
              <span>Deployment email delivery is currently disabled.</span>
            )
          }
        >
          <SmtpFields
            value={form}
            onChange={(k, v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
            password={password}
            onPasswordChange={setPassword}
          />
        </OverrideCard>

        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </form>

      <section className="space-y-3 border-t border-border pt-6">
        <div>
          <h2 className="text-sm font-semibold">Send a test email</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Uses this tenant's effective config — the override above when
            enabled, else the deployment relay. Save first if you just changed
            it.
          </p>
        </div>
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
            disabled={test.isPending}
          >
            {test.isPending ? "Sending…" : "Send test"}
          </Button>
        </div>
      </section>
    </div>
  )
}
