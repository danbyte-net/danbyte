import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type TenantSettings } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { OverrideCard } from "@/components/settings/override-card"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/tenant")({
  component: TenantGeneralPage,
})

const DEVICE_FIELDS: { key: string; label: string; hint: string }[] = [
  { key: "comments", label: "Comments", hint: "Long-form notes on a device" },
  {
    key: "location",
    label: "Location",
    hint: "Link a device to a sub-site Location",
  },
  {
    key: "cluster",
    label: "Cluster",
    hint: "Link a device to its virtualization cluster",
  },
  { key: "airflow", label: "Airflow", hint: "Chassis airflow direction" },
  { key: "latitude", label: "Latitude", hint: "GPS coordinates (for maps)" },
  { key: "longitude", label: "Longitude", hint: "GPS coordinates (for maps)" },
]

function TenantGeneralPage() {
  const { canManage, isLoading } = useMe()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ["tenant-settings"],
    queryFn: () => api<TenantSettings>("/api/tenant-settings/"),
    enabled: canManage,
  })

  const [form, setForm] = useState<TenantSettings | null>(null)
  useEffect(() => {
    if (q.data) setForm(q.data)
  }, [q.data])

  const save = useMutation({
    mutationFn: () =>
      api<TenantSettings>("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify({
          override_ui: form!.override_ui,
          override_sharing: form!.override_sharing,
          override_separation: form!.override_separation,
          device_field_visibility: form!.device_field_visibility,
          human_ids_enabled: form!.human_ids_enabled,
          enhanced_site_separation: form!.enhanced_site_separation,
          allow_site_settings: form!.allow_site_settings,
          allow_site_editor_delegation: form!.allow_site_editor_delegation,
        }),
      }),
    onSuccess: (data) => {
      setForm(data)
      qc.setQueryData(["tenant-settings"], data)
      // human-ids / share flags flow through /api/me/ and the device form.
      qc.invalidateQueries({ queryKey: ["me"] })
      qc.invalidateQueries({ queryKey: ["device-field-visibility"] })
      toast.success("Tenant settings saved")
    },
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

  const fieldOn = (key: string) =>
    form.device_field_visibility[key] ??
    dep.device_field_visibility[key] ??
    false

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
      className="max-w-5xl space-y-6"
    >
      <p className="text-xs text-muted-foreground">
        Per-tenant overrides. Groups left on{" "}
        <span className="font-medium">deployment default</span> follow the
        values a deployment admin sets under Settings → Deployment.
      </p>

      <OverrideCard
        title="UI policy"
        description="Optional device fields + human-readable object numbers for this tenant."
        overridden={form.override_ui}
        onOverriddenChange={(v) => set("override_ui", v)}
        summary={
          <span>
            Human IDs {dep.human_ids_enabled ? "on" : "off"} · visible device
            fields:{" "}
            {DEVICE_FIELDS.filter((f) => dep.device_field_visibility[f.key])
              .map((f) => f.label)
              .join(", ") || "none"}
          </span>
        }
      >
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.human_ids_enabled}
              onCheckedChange={(v) => set("human_ids_enabled", !!v)}
            />
            Human-readable object numbers (numid)
          </label>
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Optional device fields
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {DEVICE_FIELDS.map((f) => (
                <label key={f.key} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    className="mt-0.5"
                    checked={fieldOn(f.key)}
                    onCheckedChange={(v) =>
                      set("device_field_visibility", {
                        ...form.device_field_visibility,
                        [f.key]: !!v,
                      })
                    }
                  />
                  <span>
                    {f.label}
                    <span className="block text-[11px] text-muted-foreground">
                      {f.hint}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </OverrideCard>

      <OverrideCard
        title="Delegation"
        description="Site-editor delegation for this tenant."
        overridden={form.override_sharing}
        onOverriddenChange={(v) => set("override_sharing", v)}
        summary={
          <span>
            Site-editor delegation{" "}
            {dep.allow_site_editor_delegation ? "on" : "off"}
          </span>
        }
      >
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.allow_site_editor_delegation}
              onCheckedChange={(v) => set("allow_site_editor_delegation", !!v)}
            />
            Allow site editors to invite viewers to their sites
          </label>
        </div>
      </OverrideCard>

      <OverrideCard
        title="Site separation"
        description="Make each site behave like a mini-tenant: site-scoped users create only in their own site, and catalog entries they make stay local to it."
        overridden={form.override_separation}
        onOverriddenChange={(v) => set("override_separation", v)}
        summary={
          <span>
            Enhanced separation {dep.enhanced_site_separation ? "on" : "off"} ·
            site-managed settings {dep.allow_site_settings ? "on" : "off"}
          </span>
        }
      >
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={form.enhanced_site_separation}
              onCheckedChange={(v) => set("enhanced_site_separation", !!v)}
            />
            <span>
              Enhanced site separation
              <span className="block text-[11px] text-muted-foreground">
                Site-scoped users only see their own sites in pickers, new
                objects default there, and shared (site-less) objects stay
                read-only for them. Admins and cross-site users are unaffected.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={form.allow_site_settings}
              onCheckedChange={(v) => set("allow_site_settings", !!v)}
            />
            <span>
              Let site admins manage their site's settings
              <span className="block text-[11px] text-muted-foreground">
                Site editors (and holders of a sitesettings grant) get a
                Settings → This site section for e.g. email delivery.
              </span>
            </span>
          </label>
        </div>
      </OverrideCard>

      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  )
}
