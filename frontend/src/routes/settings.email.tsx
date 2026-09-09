import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SiteOption,
  SiteSettingsPayload,
  TenantSettings,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useSettingsScopes } from "@/components/settings/use-settings-scopes"
import { useUrlEnum } from "@/lib/use-url-state"
import { openingScope } from "@/lib/settings-catalog"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FormSelect } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { QueryError } from "@/components/query-error"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { SmtpFields } from "@/components/settings/smtp-fields"
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"

export const Route = createFileRoute("/settings/email")({
  component: EmailPage,
})

const SCOPES = ["deployment", "tenant", "site"] as const
type Scope = (typeof SCOPES)[number]

/** Mail, at every scope that can have its own relay (#51).
 *
 * Three pages before this - deployment, tenant and site - all rendering the
 * same `SmtpFields` and the same test box, differing only in which parent
 * they inherit from. The scope belongs on the page: from here you can see
 * what the tenant would fall back to without navigating away from it. */
function EmailPage() {
  const { isLoading } = useMe()
  const held = useSettingsScopes()
  const allowed = SCOPES.filter((s) => held[s])
  const [scope, setScope] = useUrlEnum<Scope>(
    "scope",
    openingScope("email", allowed) ?? "tenant",
    SCOPES
  )

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Tenant admin required to manage email.
      </p>
    )

  const active = allowed.includes(scope) ? scope : allowed[0]

  return (
    <div className="space-y-4">
      <SettingsHeader title="Email">
        The mail server messages are sent through, and who they reach. A tenant
        or a site can override the relay above it.
      </SettingsHeader>

      {allowed.length > 1 && (
        <SegmentedTabs
          items={[
            { value: "deployment", label: "Deployment" },
            { value: "tenant", label: "This tenant" },
            { value: "site", label: "This site" },
          ].filter((i) => allowed.includes(i.value as Scope))}
          value={active}
          onValueChange={(v) => setScope(v as Scope)}
          className="mb-4"
        />
      )}

      {active === "deployment" ? (
        <DeploymentEmail />
      ) : active === "tenant" ? (
        <TenantEmail />
      ) : (
        <SiteEmail />
      )}
    </div>
  )
}

/* ── deployment ──────────────────────────────────────────────────────── */

function DeploymentEmail() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [password, setPassword] = useState("")
  const [form, setForm] = useState<typeof data>(undefined)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  if (!data || !form) return null

  const smtpKeys = [
    "email_enabled",
    "smtp_host",
    "smtp_port",
    "smtp_security",
    "smtp_username",
    "email_from",
  ] as const

  return (
    <>
      <SettingsGrid>
        <SettingsCard
          title="Mail server"
          description="The default relay for the whole deployment. A tenant or site may point at its own instead."
          onSave={() =>
            save.mutate({
              key: "smtp",
              patch: {
                email_enabled: form.email_enabled,
                smtp_host: form.smtp_host,
                smtp_port: form.smtp_port,
                smtp_security: form.smtp_security,
                smtp_username: form.smtp_username,
                email_from: form.email_from,
                ...(password ? { smtp_password: password } : {}),
              },
            })
          }
          dirty={
            smtpKeys.some((k) => form[k] !== data[k]) || password.length > 0
          }
          saving={savingKey === "smtp"}
          saveLabel="Save mail server"
        >
          <SmtpFields
            value={form}
            onChange={(k, v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
            password={password}
            onPasswordChange={setPassword}
          />
        </SettingsCard>

        <TestCard
          endpoint="/api/deployment/email/test/"
          description="Verifies the relay above. Save first if you just changed it."
          disabled={!data.email_enabled}
          disabledNote="Enable email delivery and save to send a test."
        />

        <PreviewCard enabled={data.email_enabled} />
      </SettingsGrid>
    </>
  )
}

function PreviewCard({ enabled }: { enabled: boolean }) {
  const [to, setTo] = useState("")
  const [template, setTemplate] = useState("all")

  const templates = useQuery({
    queryKey: ["email-templates"],
    queryFn: () =>
      api<{ templates: { key: string; label: string }[] }>(
        "/api/deployment/email/templates/"
      ),
  })

  const preview = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; to?: string; sent?: string[] }>(
        "/api/deployment/email/preview/",
        {
          method: "POST",
          body: JSON.stringify({ to: to || undefined, template }),
        }
      ),
    onSuccess: (r) =>
      toast.success(
        `Sent ${r.sent?.length ?? 0} preview email${
          (r.sent?.length ?? 0) === 1 ? "" : "s"
        } to ${r.to}`
      ),
    onError: (err) => apiErrorToast(err),
  })

  return (
    <SettingsCard
      title="Preview templates"
      description="Send a sample of any email - digest, alerts, sign-in code, invite - filled with example data, so you can see it before it goes out for real."
    >
      <FormSelect
        label="Template"
        value={template}
        onChange={(v) => v && setTemplate(v)}
        options={[
          { value: "all", label: "All templates" },
          ...(templates.data?.templates ?? []).map((t) => ({
            value: t.key,
            label: t.label,
          })),
        ]}
      />
      <div className="flex items-end gap-2">
        <Field label="Recipient" className="flex-1">
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@acme.com (defaults to your account email)"
            className="font-mono text-[13px]"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          onClick={() => preview.mutate()}
          disabled={preview.isPending || !enabled}
        >
          {preview.isPending ? "Sending…" : "Send preview"}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Subjects are prefixed with <span className="font-mono">[Preview]</span>.
        Uses the relay for the scope you are in.
      </p>
    </SettingsCard>
  )
}

/* ── tenant ──────────────────────────────────────────────────────────── */

function TenantEmail() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: () => api<TenantSettings>("/api/tenant-settings/"),
  })
  const [form, setForm] = useState<TenantSettings | null>(null)
  const [password, setPassword] = useState("")

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
      toast.success("Tenant email saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (!form) return <p className="text-sm text-muted-foreground">Loading…</p>

  const dep = form.deployment_defaults
  return (
    <SettingsGrid>
      <SettingsCard
        title="Mail server"
        description="This tenant's alert and invite email. Override to use a tenant-specific relay and From address."
        inherit={{
          overridden: form.override_email,
          onChange: (v) => setForm({ ...form, override_email: v }),
          summary: (
            <RelaySummary
              enabled={dep.email_enabled}
              host={dep.smtp_host}
              from={dep.email_from}
              what="Deployment"
            />
          ),
        }}
        onSave={() => save.mutate()}
        dirty={JSON.stringify(form) !== JSON.stringify(q.data) || !!password}
        saving={save.isPending}
        saveLabel="Save mail server"
      >
        <SmtpFields
          value={form}
          onChange={(k, v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
          password={password}
          onPasswordChange={setPassword}
        />
      </SettingsCard>

      <TestCard
        endpoint="/api/tenant-settings/email/test/"
        description="Uses this tenant's effective relay - the override when on, else the deployment one."
      />
    </SettingsGrid>
  )
}

/* ── site ────────────────────────────────────────────────────────────── */

function SiteEmail() {
  const { me } = useMe()
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
      toast.success(`Saved email for ${data.site.name}`)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (sites.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No site here has its own settings.
      </p>
    )
  if (q.isError) return <QueryError error={q.error} />

  const parent = form?.parent_defaults
  return (
    <div className="space-y-4">
      <div className="max-w-xs">
        <FormSelect
          label="Site"
          value={siteId ?? ""}
          onChange={(v) => setSiteId(v)}
          options={sites.map((s) => ({ value: s.id, label: s.name }))}
        />
      </div>

      {!form ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <SettingsGrid>
          <SettingsCard
            title="Mail server"
            description="Only alerts scoped to this site use this relay. Everything else keeps using the tenant's."
            inherit={{
              overridden: form.override_email,
              onChange: (v) => setForm({ ...form, override_email: v }),
              summary: (
                <RelaySummary
                  enabled={!!parent?.email_enabled}
                  host={parent?.smtp_host}
                  from={parent?.email_from}
                  what="Tenant"
                />
              ),
              labels: { on: "Overriding", off: "Using the tenant relay" },
            }}
            onSave={() => save.mutate()}
            dirty={
              JSON.stringify(form) !== JSON.stringify(q.data) || !!password
            }
            saving={save.isPending}
            saveLabel="Save mail server"
          >
            <SmtpFields
              value={form}
              onChange={(k, v) => setForm((f) => (f ? { ...f, [k]: v } : f))}
              password={password}
              onPasswordChange={setPassword}
            />
          </SettingsCard>

          {siteId && (
            <TestCard
              endpoint={`/api/sites/${siteId}/settings/email/test/`}
              description="Uses this site's effective relay."
            />
          )}
        </SettingsGrid>
      )}
    </div>
  )
}

/* ── shared bits ─────────────────────────────────────────────────────── */

/** What a scope falls back to when it is not overriding. */
function RelaySummary({
  enabled,
  host,
  from,
  what,
}: {
  enabled: boolean
  host?: string
  from?: string
  what: string
}) {
  if (!enabled) return <span>{what} email delivery is currently off.</span>
  return (
    <span>
      {what} relay{" "}
      <span className="font-mono text-[13px]">{host || "(env backend)"}</span>
      {from && (
        <>
          {" "}
          · from <span className="font-mono text-[13px]">{from}</span>
        </>
      )}
    </span>
  )
}

/** Send a test through whichever relay this scope resolves to. */
function TestCard({
  endpoint,
  description,
  disabled,
  disabledNote,
}: {
  endpoint: string
  description: string
  disabled?: boolean
  disabledNote?: string
}) {
  const [to, setTo] = useState("")
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; to?: string; via?: string }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ to: to || undefined }),
      }),
    onSuccess: (r) =>
      toast.success(
        r.via
          ? `Test sent to ${r.to} via the ${r.via} relay`
          : `Test email sent to ${r.to}`
      ),
    onError: (err) => apiErrorToast(err),
  })

  return (
    <SettingsCard title="Send a test" description={description}>
      <div className="flex items-end gap-2">
        <Field label="Recipient" className="flex-1">
          <Input
            type="email"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="you@acme.com (defaults to your account email)"
            className="font-mono text-[13px]"
          />
        </Field>
        <Button
          type="button"
          variant="secondary"
          onClick={() => test.mutate()}
          disabled={test.isPending || disabled}
        >
          {test.isPending ? "Sending…" : "Send test"}
        </Button>
      </div>
      {disabled && disabledNote && (
        <p className="text-[11px] text-muted-foreground">{disabledNote}</p>
      )}
    </SettingsCard>
  )
}
