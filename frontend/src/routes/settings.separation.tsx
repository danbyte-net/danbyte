import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { TenantSettings } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlEnum } from "@/lib/use-url-state"
import { openingScope } from "@/lib/settings-catalog"
import { FormCheckbox } from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { SeparationDeploymentCards } from "@/components/settings/separation-deployment"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/separation")({
  component: SeparationPage,
})

const SCOPES = ["deployment", "tenant"] as const
type Scope = (typeof SCOPES)[number]

/** Site separation and delegation, at both scopes (#51).
 *
 * Kept as its own page rather than folded into tenant policy: it governs a
 * security boundary, and something easy to change by accident should be
 * somewhere you went on purpose. */
function SeparationPage() {
  const { canManage, canManageDeployment, isLoading } = useMe()
  const allowed = SCOPES.filter((s) =>
    s === "deployment" ? canManageDeployment : canManage
  )
  const [scope, setScope] = useUrlEnum<Scope>(
    "scope",
    openingScope("separation", allowed) ?? "tenant",
    SCOPES
  )

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">Tenant admin required.</p>
    )

  const active = allowed.includes(scope) ? scope : allowed[0]

  return (
    <div className="space-y-4">
      <SettingsHeader title="Separation">
        How sites behave for site-scoped users, and what local site admins may
        manage themselves.
      </SettingsHeader>

      {allowed.length > 1 && (
        <SegmentedTabs
          items={[
            { value: "deployment", label: "Deployment" },
            { value: "tenant", label: "This tenant" },
          ]}
          value={active}
          onValueChange={setScope}
          className="mb-4"
        />
      )}

      {active === "deployment" ? (
        <SeparationDeploymentCards />
      ) : (
        <TenantSeparation />
      )}
    </div>
  )
}

/** The tenant's own override of each group.
 *
 * These two cards used to live on the tenant General page under one
 * page-wide save; each owns its save now, so turning separation on cannot
 * quietly write a UI-policy edit made ten minutes earlier. */
function TenantSeparation() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: () => api<TenantSettings>("/api/tenant-settings/"),
  })
  const [form, setForm] = useState<TenantSettings | null>(null)

  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const save = useMutation({
    mutationFn: (patch: Partial<TenantSettings>) =>
      api<TenantSettings>("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      setForm(data)
      qc.setQueryData(["tenant-settings"], data)
      toast.success("Saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (q.isError) return <QueryError error={q.error} />
  if (!form || !q.data)
    return <p className="text-sm text-muted-foreground">Loading…</p>

  const dep = form.deployment_defaults
  const server = q.data
  const set = <TKey extends keyof TenantSettings>(
    k: TKey,
    v: TenantSettings[TKey]
  ) => setForm({ ...form, [k]: v })

  return (
    <SettingsGrid>
      <SettingsCard
        title="Site separation"
        description="Make each site behave like a mini-tenant for site-scoped users."
        inherit={{
          overridden: form.override_separation,
          onChange: (v) => set("override_separation", v),
          summary: (
            <span>
              Enhanced separation {dep.enhanced_site_separation ? "on" : "off"}{" "}
              · site-managed settings {dep.allow_site_settings ? "on" : "off"}
            </span>
          ),
        }}
        onSave={() =>
          save.mutate({
            override_separation: form.override_separation,
            enhanced_site_separation: form.enhanced_site_separation,
            allow_site_settings: form.allow_site_settings,
          })
        }
        dirty={
          form.override_separation !== server.override_separation ||
          form.enhanced_site_separation !== server.enhanced_site_separation ||
          form.allow_site_settings !== server.allow_site_settings
        }
        saving={save.isPending}
        saveLabel="Save separation"
      >
        <FormCheckbox
          label="Enhanced site separation"
          checked={form.enhanced_site_separation}
          onChange={(v) => set("enhanced_site_separation", v)}
          hint="Site-scoped users only see their own sites in pickers, new objects default there, and shared (site-less) objects stay read-only for them. Admins and cross-site users are unaffected."
        />
        <FormCheckbox
          label="Let site admins manage their site's settings"
          checked={form.allow_site_settings}
          onChange={(v) => set("allow_site_settings", v)}
          hint="Site editors (and holders of a sitesettings grant) get the This site scope on Settings → Email."
        />
      </SettingsCard>

      <SettingsCard
        title="Delegation"
        description="Site-editor delegation for this tenant."
        inherit={{
          overridden: form.override_sharing,
          onChange: (v) => set("override_sharing", v),
          summary: (
            <span>
              Site-editor delegation{" "}
              {dep.allow_site_editor_delegation ? "on" : "off"}
            </span>
          ),
        }}
        onSave={() =>
          save.mutate({
            override_sharing: form.override_sharing,
            allow_site_editor_delegation: form.allow_site_editor_delegation,
          })
        }
        dirty={
          form.override_sharing !== server.override_sharing ||
          form.allow_site_editor_delegation !==
            server.allow_site_editor_delegation
        }
        saving={save.isPending}
        saveLabel="Save delegation"
      >
        <FormCheckbox
          label="Allow site editors to invite viewers to their sites"
          checked={form.allow_site_editor_delegation}
          onChange={(v) => set("allow_site_editor_delegation", v)}
          hint="A local site editor may grant read-only access to the site(s) they edit - never editors, never other sites."
        />
      </SettingsCard>
    </SettingsGrid>
  )
}
