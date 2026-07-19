import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type Paginated, type SiteSettingsPayload } from "@/lib/api"
import type { SiteOption } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FormSelect } from "@/components/forms"
import { OverrideCard } from "@/components/settings/override-card"
import { SmtpFields } from "@/components/settings/smtp-fields"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/site")({
  component: SiteSettingsPage,
})

// Per-SITE settings (email v1) — for orgs whose sites run their own IT.
// Who sees this page: tenant admins always; otherwise the tenant's
// "site-managed settings" switch must be on AND the user must be a site
// editor there or hold a `sitesettings` grant (me.settings_sites).
function SiteSettingsPage() {
  const { me, isLoading } = useMe()
  const qc = useQueryClient()
  const allowed = me.settings_sites ?? []

  const sitesQ = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/"),
    staleTime: 10 * 60_000,
  })
  const sites = (sitesQ.data?.results ?? []).filter(
    (s) =>
      allowed === "all" || (Array.isArray(allowed) && allowed.includes(s.id))
  )

  const [siteId, setSiteId] = useState<string | null>(null)
  useEffect(() => {
    if (!siteId && sites.length > 0) setSiteId(sites[0].id)
  }, [siteId, sites])

  const q = useQuery({
    queryKey: ["site-settings", siteId],
    queryFn: () => api<SiteSettingsPayload>(`/api/sites/${siteId}/settings/`),
    enabled: !!siteId,
  })

  const [form, setForm] = useState<SiteSettingsPayload | null>(null)
  const [password, setPassword] = useState("")
  const [testTo, setTestTo] = useState("")
  useEffect(() => {
    setForm(q.data ?? null)
    setPassword("")
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<SiteSettingsPayload>(`/api/sites/${siteId}/settings/`, {
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
      qc.setQueryData(["site-settings", siteId], data)
      toast.success(`Saved settings for ${data.site.name}`)
    },
    onError: (err) => apiErrorToast(err),
  })

  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; to?: string; via?: string }>(
        `/api/sites/${siteId}/settings/email/test/`,
        { method: "POST", body: JSON.stringify({ to: testTo || undefined }) }
      ),
    onSuccess: (r) =>
      toast.success(
        `Test email sent to ${r.to} via the ${
          r.via === "site"
            ? "site relay"
            : r.via === "tenant"
              ? "tenant relay"
              : "deployment relay"
        }`
      ),
    onError: (err) => apiErrorToast(err),
  })

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed !== "all" && allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Site admin required (and the tenant must allow site-managed settings).
      </p>
    )
  if (q.isError) return <QueryError error={q.error} />

  const parent = form?.parent_defaults
  const set = <K extends keyof SiteSettingsPayload>(
    key: K,
    value: SiteSettingsPayload[K]
  ) => setForm((f) => (f ? { ...f, [key]: value } : f))

  return (
    <div className="max-w-5xl space-y-6">
      <p className="text-xs text-muted-foreground">
        Settings for a single site — local IT manages its own overrides here.
        Groups left on <span className="font-medium">inherited</span> follow the
        tenant (or deployment) values.
      </p>

      {sites.length > 1 && (
        <div className="max-w-xs">
          <FormSelect
            label="Site"
            value={siteId}
            onChange={(v) => setSiteId(v)}
            options={sites.map((s) => ({ value: s.id, label: s.name }))}
          />
        </div>
      )}

      {!form ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              save.mutate()
            }}
            className="space-y-6"
          >
            <OverrideCard
              title={`Email (SMTP) — ${form.site.name}`}
              description="Alert emails about this site's objects. Override to use a site-local relay and From address."
              overridden={form.override_email}
              onOverriddenChange={(v) => set("override_email", v)}
              summary={
                parent?.email_enabled ? (
                  <span>
                    Inherited relay{" "}
                    <span className="font-mono text-[13px]">
                      {parent.smtp_host || "(env backend)"}
                    </span>
                    {parent.email_from && (
                      <>
                        {" "}
                        · from{" "}
                        <span className="font-mono text-[13px]">
                          {parent.email_from}
                        </span>
                      </>
                    )}
                  </span>
                ) : (
                  <span>Inherited email delivery is currently disabled.</span>
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
                Uses this site's effective config — the override above when
                enabled, else the tenant/deployment relay. Save first if you
                just changed it. Note: only alerts about this site's objects use
                the site relay; sign-in codes and digests stay on the
                tenant/deployment relay.
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
        </>
      )}
    </div>
  )
}
