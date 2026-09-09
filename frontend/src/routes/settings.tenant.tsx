import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { Rocket } from "lucide-react"

import { api, type TenantSettings } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { openOnboardingWizard } from "@/components/onboarding-wizard"
import { Checkbox } from "@/components/ui/checkbox"
import { FormCombobox, FormSelect } from "@/components/forms"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { useTimezoneOptions } from "@/lib/use-timezones"

export const Route = createFileRoute("/settings/tenant")({
  component: TenantGeneralPage,
})

const DATE_FORMAT_OPTIONS = [
  { value: "YYYY-MM-DD", label: "2026-01-31 (ISO)" },
  { value: "DD.MM.YYYY", label: "31.01.2026" },
  { value: "DD/MM/YYYY", label: "31/01/2026" },
  { value: "MM/DD/YYYY", label: "01/31/2026" },
  { value: "DD MMM YYYY", label: "31 Jan 2026" },
]

const TIME_STYLE_OPTIONS = [
  { value: "24h", label: "24-hour (14:30)" },
  { value: "12h", label: "12-hour (2:30 PM)" },
]

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
  const timezoneOptions = useTimezoneOptions()
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
    mutationFn: (patch: Partial<TenantSettings>) =>
      api<TenantSettings>("/api/tenant-settings/", {
        method: "PUT",
        body: JSON.stringify(patch),
      }),
    onSuccess: (data) => {
      setForm(data)
      qc.setQueryData(["tenant-settings"], data)
      // human-ids / share flags flow through /api/me/ and the device form.
      qc.invalidateQueries({ queryKey: ["me"] })
      qc.invalidateQueries({ queryKey: ["device-field-visibility"] })
      toast.success("Saved")
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

  const server = q.data
  return (
    <div className="max-w-5xl space-y-4">
      <SettingsHeader title="Tenant policy">
        Rules for this tenant. A card left on its deployment default follows
        whatever a deployment admin sets.
      </SettingsHeader>

      <SettingsCard
        title="First-time setup"
        description="Re-open the guided wizard to add a site, prefix, VLAN or device."
        layout="plain"
        footer={
          <Button
            type="button"
            variant="outline"
            onClick={openOnboardingWizard}
          >
            <Rocket className="h-3.5 w-3.5" /> Re-run setup
          </Button>
        }
      >
        <></>
      </SettingsCard>

      <SettingsCard
        title="UI policy"
        description="Optional device fields and human-readable object numbers."
        inherit={{
          overridden: form.override_ui,
          onChange: (v) => set("override_ui", v),
          summary: (
            <span>
              Human IDs {dep.human_ids_enabled ? "on" : "off"} · visible device
              fields:{" "}
              {DEVICE_FIELDS.filter((f) => dep.device_field_visibility[f.key])
                .map((f) => f.label)
                .join(", ") || "none"}
            </span>
          ),
        }}
        layout="plain"
        onSave={() =>
          save.mutate({
            override_ui: form.override_ui,
            device_field_visibility: form.device_field_visibility,
            human_ids_enabled: form.human_ids_enabled,
          })
        }
        dirty={
          !!server &&
          (form.override_ui !== server.override_ui ||
            form.human_ids_enabled !== server.human_ids_enabled ||
            JSON.stringify(form.device_field_visibility) !==
              JSON.stringify(server.device_field_visibility))
        }
        saving={save.isPending}
        saveLabel="Save UI policy"
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
      </SettingsCard>

      <SettingsCard
        title="Date & time"
        description="How dates and times render here - each person can still pick their own under Preferences."
        inherit={{
          overridden: form.override_datetime,
          onChange: (v) => set("override_datetime", v),
          summary: (
            <span>
              Dates {dep.date_format} ·{" "}
              {dep.time_style === "12h" ? "12-hour" : "24-hour"} clock ·{" "}
              {dep.display_timezone}
            </span>
          ),
        }}
        layout="plain"
        onSave={() =>
          save.mutate({
            override_datetime: form.override_datetime,
            date_format: form.date_format,
            time_style: form.time_style,
            display_timezone: form.display_timezone,
          })
        }
        dirty={
          !!server &&
          (form.override_datetime !== server.override_datetime ||
            form.date_format !== server.date_format ||
            form.time_style !== server.time_style ||
            form.display_timezone !== server.display_timezone)
        }
        saving={save.isPending}
        saveLabel="Save date & time"
      >
        <div className="grid gap-4 sm:max-w-md">
          <FormSelect
            label="Date format"
            value={form.date_format}
            onChange={(v) =>
              v && set("date_format", v as TenantSettings["date_format"])
            }
            options={DATE_FORMAT_OPTIONS}
          />
          <FormSelect
            label="Clock"
            value={form.time_style}
            onChange={(v) =>
              v && set("time_style", v as TenantSettings["time_style"])
            }
            options={TIME_STYLE_OPTIONS}
          />
          <FormCombobox
            label="Timezone"
            hint="IANA timezone times render in. Server default = the backend's TIME_ZONE."
            value={form.display_timezone || null}
            onChange={(v) => set("display_timezone", v ?? "")}
            noneLabel="Server default"
            placeholder="Server default"
            searchPlaceholder="Search timezones…"
            options={timezoneOptions}
          />
        </div>
      </SettingsCard>
    </div>
  )
}
