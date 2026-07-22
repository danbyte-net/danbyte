import { useEffect, useRef, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Lock } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DeploymentSettings,
  type DeviceFieldVisibility,
} from "@/lib/api"
import { TABLES, type TableMeta } from "@/lib/tables"
import {
  useTablePreference,
  putTableDefault,
  deleteTableDefault,
} from "@/lib/use-table-preference"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormSelect,
} from "@/components/forms"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

const DEVICE_FIELDS: {
  key: keyof DeviceFieldVisibility
  label: string
  hint: string
}[] = [
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

function timezoneOptions(): { value: string; label: string }[] {
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC"]
  return zones.map((z) => ({ value: z, label: z }))
}

export const Route = createFileRoute("/settings/admin")({
  component: AdminPage,
})

function AdminPage() {
  const { canManageDeployment: canManage, isLoading } = useMe()
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }
  if (!canManage) {
    return (
      <p className="text-sm text-muted-foreground">
        You need the <span className="font-mono">users.manage</span> permission
        to manage tenant table defaults.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="General">
        Deployment-wide settings for this whole install. Each card saves on its
        own — the button only writes the fields above it.
      </SettingsHeader>
      <SettingsGrid>
        <DeploymentSection />
        <DeviceFieldsSection />
      </SettingsGrid>
      {/* Full width, so it sits AFTER the grid rather than spanning it — every
          table's default columns is a long list that would leave a hole beside
          it in one column. */}
      <SettingsCard
        title="Tenant table defaults"
        description={
          <>
            Publish your current column layout as the starting point for
            everyone in this tenant. <span className="font-medium">Lock</span>{" "}
            it to force the layout — users keep their saved layouts but can't
            change locked tables until you unlock.
          </>
        }
      >
        <div className="divide-y rounded-lg border border-border">
          {TABLES.map((t) => (
            <AdminTableRow key={t.id} table={t} />
          ))}
        </div>
      </SettingsCard>
    </div>
  )
}

// The favicon is a file, not a JSON field, so it saves the moment you pick one
// (its own multipart endpoint) rather than riding the Identity card's Save.
function FaviconField({ faviconUrl }: { faviconUrl: string | null }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<null | "upload" | "reset">(null)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deployment-email"] })
    qc.invalidateQueries({ queryKey: ["me"] }) // live-swaps the tab icon
  }

  const upload = async (file: File) => {
    setBusy("upload")
    try {
      const body = new FormData()
      body.append("favicon", file)
      await api("/api/deployment/favicon/", { method: "POST", body })
      refresh()
      toast.success("Favicon updated")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  const reset = async () => {
    setBusy("reset")
    try {
      await api("/api/deployment/favicon/", { method: "DELETE" })
      refresh()
      toast.success("Favicon reset to the Danbyte default")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Field
      label="Browser-tab icon"
      hint="Shown in the browser tab and bookmarks. A small square PNG or ICO works best; max 1 MB. Blank = the Danbyte icon."
    >
      <div className="flex items-center gap-3">
        <img
          src={faviconUrl || "/favicon-32.png"}
          alt=""
          className="size-8 rounded border border-border bg-background object-contain p-0.5"
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/x-icon,image/vnd.microsoft.icon,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void upload(f)
            e.target.value = ""
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy !== null}
          onClick={() => inputRef.current?.click()}
        >
          {busy === "upload" ? "Uploading…" : "Upload…"}
        </Button>
        {faviconUrl && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy !== null}
            onClick={() => void reset()}
          >
            {busy === "reset" ? "Resetting…" : "Reset to default"}
          </Button>
        )}
      </div>
    </Field>
  )
}

function DeploymentSection() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ["deployment-email"],
    queryFn: () => api<DeploymentSettings>("/api/deployment/email/"),
  })
  const [name, setName] = useState<string | null>(null)
  const [days, setDays] = useState<string | null>(null)
  const [delegate, setDelegate] = useState(false)
  const [separation, setSeparation] = useState(false)
  const [siteSettings, setSiteSettings] = useState(false)
  const [ssrfList, setSsrfList] = useState("")
  const [tileUrl, setTileUrl] = useState("")
  const [tileAttrib, setTileAttrib] = useState("")
  const [satUrl, setSatUrl] = useState("")
  const [satAttrib, setSatAttrib] = useState("")
  const [driftEnabled, setDriftEnabled] = useState(false)
  const [driftInterval, setDriftInterval] = useState<string | null>(null)
  const [digestEnabled, setDigestEnabled] = useState(false)
  const [digestFrequency, setDigestFrequency] = useState("weekly")
  const [digestWeekday, setDigestWeekday] = useState("0")
  const [digestRecipients, setDigestRecipients] = useState("")
  const [humanIds, setHumanIds] = useState(true)
  const [dateFormat, setDateFormat] = useState<string>("YYYY-MM-DD")
  const [timeStyle, setTimeStyle] = useState<string>("24h")
  const [displayTz, setDisplayTz] = useState("")
  useEffect(() => {
    if (data) {
      setName(data.deployment_name)
      setDays(String(data.changelog_retention_days))
      setDelegate(data.allow_site_editor_delegation)
      setSeparation(data.enhanced_site_separation)
      setSiteSettings(data.allow_site_settings)
      setSsrfList((data.ssrf_allowlist ?? []).join("\n"))
      setTileUrl(data.map_tile_url ?? "")
      setTileAttrib(data.map_tile_attribution ?? "")
      setSatUrl(data.map_satellite_url ?? "")
      setSatAttrib(data.map_satellite_attribution ?? "")
      setDriftEnabled(data.config_drift_enabled)
      setDriftInterval(String(data.config_drift_interval_minutes))
      setDigestEnabled(data.digest_enabled)
      setDigestFrequency(data.digest_frequency)
      setDigestWeekday(String(data.digest_weekday))
      setDigestRecipients(data.digest_recipients)
      setHumanIds(data.human_ids_enabled)
      setDateFormat(data.date_format)
      setTimeStyle(data.time_style)
      setDisplayTz(data.display_timezone)
    }
  }, [data])

  // One mutation, called per card with only that card's fields. Spreading the
  // SERVER's `data` (not local state) means saving one card can never
  // accidentally persist another card's unsaved edits.
  const [savingKey, setSavingKey] = useState<string | null>(null)
  const save = useMutation({
    mutationFn: (v: { key: string; patch: Partial<DeploymentSettings> }) =>
      api<DeploymentSettings>("/api/deployment/email/", {
        method: "PUT",
        body: JSON.stringify({ ...data, ...v.patch }),
      }),
    onMutate: (v) => setSavingKey(v.key),
    onSettled: () => setSavingKey(null),
    onSuccess: (d) => {
      qc.setQueryData(["deployment-email"], d)
      qc.invalidateQueries({ queryKey: ["me"] })
      toast.success("Saved")
    },
    onError: (e) => apiErrorToast(e),
  })

  const testDigest = useMutation({
    mutationFn: () =>
      api("/api/tenant-settings/digest/test/", { method: "POST", body: "{}" }),
    onSuccess: () => toast.success("Test digest sent for the active tenant."),
    onError: (e) => apiErrorToast(e),
  })

  if (!data) return null
  return (
    <>
      <SettingsCard
        title="Identity"
        description="What this install calls itself, and how long it keeps history."
        onSave={() =>
          save.mutate({
            key: "identity",
            patch: {
              deployment_name: name ?? "",
              changelog_retention_days: Math.max(0, Number(days) || 0),
            },
          })
        }
        dirty={
          name !== data.deployment_name ||
          days !== String(data.changelog_retention_days)
        }
        saving={savingKey === "identity"}
        saveLabel="Save identity"
      >
        <Field
          label="Deployment name"
          hint={
            "The app name — shown in the sidebar header, the browser tab title, " +
            'and the login page. Blank = "Danbyte".'
          }
        >
          <Input
            value={name ?? ""}
            onChange={(e) => setName(e.target.value)}
            placeholder="Danbyte"
          />
        </Field>
        <Field
          label="Audit log retention (days)"
          hint="Change-log entries older than this are pruned daily. 0 = keep forever."
        >
          <Input
            type="number"
            min={0}
            value={days ?? ""}
            onChange={(e) => setDays(e.target.value)}
            className="w-40"
          />
        </Field>
        <FaviconField faviconUrl={data.favicon_url} />
      </SettingsCard>

      <SettingsCard
        title="Date & time"
        description="Default date format, clock, and timezone for the whole install. Tenants can override under Settings → This tenant; users under Preferences."
        onSave={() =>
          save.mutate({
            key: "datetime",
            patch: {
              date_format: dateFormat as DeploymentSettings["date_format"],
              time_style: timeStyle as DeploymentSettings["time_style"],
              display_timezone: displayTz,
            },
          })
        }
        dirty={
          dateFormat !== data.date_format ||
          timeStyle !== data.time_style ||
          displayTz !== data.display_timezone
        }
        saving={savingKey === "datetime"}
        saveLabel="Save date & time"
      >
        <FormSelect
          label="Date format"
          value={dateFormat}
          onChange={(v) => v && setDateFormat(v)}
          options={DATE_FORMAT_OPTIONS}
        />
        <FormSelect
          label="Clock"
          value={timeStyle}
          onChange={(v) => v && setTimeStyle(v)}
          options={TIME_STYLE_OPTIONS}
        />
        <FormCombobox
          label="Timezone"
          hint="IANA timezone times render in. Server default = the backend's TIME_ZONE (UTC unless configured)."
          value={displayTz || null}
          onChange={(v) => setDisplayTz(v ?? "")}
          noneLabel="Server default"
          placeholder="Server default"
          searchPlaceholder="Search timezones…"
          options={timezoneOptions()}
        />
      </SettingsCard>

      <SettingsCard
        title="Delegation"
        description="Opt-in features, off by default."
        onSave={() =>
          save.mutate({
            key: "sharing",
            patch: {
              allow_site_editor_delegation: delegate,
            },
          })
        }
        dirty={delegate !== data.allow_site_editor_delegation}
        saving={savingKey === "sharing"}
        saveLabel="Save delegation"
      >
        <FormCheckbox
          label="Let site editors invite their own viewers"
          checked={delegate}
          onChange={setDelegate}
          hint="A local site editor may grant read-only access to the site(s) they edit — never editors, never other sites."
        />
      </SettingsCard>

      <SettingsCard
        title="Outbound connections"
        description="Internal hosts the server may reach despite the SSRF guard — e.g. an internal NetBox for the importer, or an internal SMTP relay."
        onSave={() =>
          save.mutate({
            key: "ssrf",
            patch: {
              ssrf_allowlist: ssrfList
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
            },
          })
        }
        dirty={ssrfList !== (data.ssrf_allowlist ?? []).join("\n")}
        saving={savingKey === "ssrf"}
        saveLabel="Save allowlist"
      >
        <Field
          label="Allowed addresses / CIDRs"
          hint="One per line, e.g. 10.196.223.134 or 10.196.0.0/16. Merged with DANBYTE_SSRF_ALLOWLIST."
        >
          <textarea
            value={ssrfList}
            onChange={(e) => setSsrfList(e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={"10.196.223.134\n192.168.10.0/24"}
            className="w-full rounded-md border border-input bg-transparent p-2 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </Field>
        <p className="text-[11px] text-muted-foreground">
          The guard stops tenant-supplied URLs (NetBox imports, webhooks, SMTP
          relays) from reaching loopback, cloud-metadata, and private ranges.
          Entries here punch specific holes — keep it as narrow as possible.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Map tiles"
        description="The tile server behind the Site map. Blank = OpenStreetMap's standard tiles (fine for light use; run your own tile server for heavy or offline deployments)."
        onSave={() =>
          save.mutate({
            key: "tiles",
            patch: {
              map_tile_url: tileUrl.trim(),
              map_tile_attribution: tileAttrib.trim(),
              map_satellite_url: satUrl.trim(),
              map_satellite_attribution: satAttrib.trim(),
            },
          })
        }
        dirty={
          tileUrl !== (data.map_tile_url ?? "") ||
          tileAttrib !== (data.map_tile_attribution ?? "") ||
          satUrl !== (data.map_satellite_url ?? "") ||
          satAttrib !== (data.map_satellite_attribution ?? "")
        }
        saving={savingKey === "tiles"}
        saveLabel="Save map tiles"
      >
        <Field
          label="Tile URL template"
          hint="https, with {z}/{x}/{y} placeholders"
        >
          <Input
            value={tileUrl}
            onChange={(e) => setTileUrl(e.target.value)}
            placeholder="https://tiles.example.com/{z}/{x}/{y}.png"
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Attribution"
          hint="shown on the map — required by most tile providers"
        >
          <Input
            value={tileAttrib}
            onChange={(e) => setTileAttrib(e.target.value)}
            placeholder='&copy; <a href="…">My tiles</a>'
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Satellite tile URL template"
          hint="blank = Esri World Imagery"
        >
          <Input
            value={satUrl}
            onChange={(e) => setSatUrl(e.target.value)}
            placeholder="https://tiles.example.com/sat/{z}/{y}/{x}"
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Field>
        <Field
          label="Satellite attribution"
          hint="shown when the satellite basemap is active"
        >
          <Input
            value={satAttrib}
            onChange={(e) => setSatAttrib(e.target.value)}
            placeholder="Tiles &copy; Esri …"
            className="font-mono text-[12px]"
            spellCheck={false}
          />
        </Field>
        <p className="text-[11px] text-muted-foreground">
          A custom tile host also needs to be allowed in the nginx CSP (img-src)
          — see the Site map docs. OpenStreetMap's servers are donation-funded:
          keep the default only for light internal use, per their tile usage
          policy.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Site separation"
        description="Deployment default — tenants can override it under This tenant → General."
        onSave={() =>
          save.mutate({
            key: "separation",
            patch: {
              enhanced_site_separation: separation,
              allow_site_settings: siteSettings,
            },
          })
        }
        dirty={
          separation !== data.enhanced_site_separation ||
          siteSettings !== data.allow_site_settings
        }
        saving={savingKey === "separation"}
        saveLabel="Save separation"
      >
        <FormCheckbox
          label="Enhanced site separation"
          checked={separation}
          onChange={setSeparation}
          hint="Each site behaves like a mini-tenant for site-scoped users: pickers offer only their sites, new objects default there, shared (site-less) objects stay read-only. Admins and cross-site users are unaffected."
        />
        <FormCheckbox
          label="Let site admins manage their site's settings"
          checked={siteSettings}
          onChange={setSiteSettings}
          hint="Site editors (and holders of a sitesettings grant) get a Settings → This site section — e.g. their own email delivery."
        />
      </SettingsCard>

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
              config_drift_enabled: driftEnabled,
              config_drift_interval_minutes: Math.min(
                10080,
                Math.max(1, Number(driftInterval) || 60)
              ),
            },
          })
        }
        dirty={
          driftEnabled !== data.config_drift_enabled ||
          driftInterval !== String(data.config_drift_interval_minutes)
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
          checked={driftEnabled}
          onChange={setDriftEnabled}
          hint="Periodically compare device configuration against the expected baseline."
        />
        {driftEnabled && (
          <Field
            label="Run every N minutes"
            hint="How often to dispatch a drift run (1–10080)."
          >
            <Input
              type="number"
              min={1}
              max={10080}
              value={driftInterval ?? ""}
              onChange={(e) => setDriftInterval(e.target.value)}
              className="w-40"
            />
          </Field>
        )}
      </SettingsCard>

      <SettingsCard
        title="Email digest"
        description="Email a periodic monitoring/status summary (up/down, alerts, recent changes) to a recipient list. Deployment-wide default; a tenant can override it."
        onSave={() =>
          save.mutate({
            key: "digest",
            patch: {
              digest_enabled: digestEnabled,
              digest_frequency: digestFrequency as "daily" | "weekly",
              digest_weekday: Math.max(
                0,
                Math.min(6, Number(digestWeekday) || 0)
              ),
              digest_recipients: digestRecipients,
            },
          })
        }
        dirty={
          digestEnabled !== data.digest_enabled ||
          digestFrequency !== data.digest_frequency ||
          digestWeekday !== String(data.digest_weekday) ||
          digestRecipients !== data.digest_recipients
        }
        saving={savingKey === "digest"}
        saveLabel="Save digest"
      >
        <FormCheckbox
          label="Send an email digest"
          checked={digestEnabled}
          onChange={setDigestEnabled}
          hint="A scheduled summary email — daily, or weekly on a chosen day."
        />
        {digestEnabled && (
          <>
            <FormSelect
              label="Frequency"
              value={digestFrequency}
              onChange={(v) => v && setDigestFrequency(v)}
              options={[
                { value: "daily", label: "Daily" },
                { value: "weekly", label: "Weekly" },
              ]}
            />
            {digestFrequency === "weekly" && (
              <FormSelect
                label="Day of week"
                value={digestWeekday}
                onChange={(v) => v && setDigestWeekday(v)}
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
                value={digestRecipients}
                onChange={(e) => setDigestRecipients(e.target.value)}
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
      </SettingsCard>

      <SettingsCard
        title="Human-readable IDs"
        description={
          <>
            Show a short per-tenant number (e.g.{" "}
            <span className="num">#27</span>) alongside each object's ID — handy
            when migrating from a tool whose integer IDs are printed on physical
            labels. Numbers are assigned per tenant, so each tenant counts from
            1 independently.
          </>
        }
        onSave={() =>
          save.mutate({ key: "ids", patch: { human_ids_enabled: humanIds } })
        }
        dirty={humanIds !== data.human_ids_enabled}
        saving={savingKey === "ids"}
        saveLabel="Save IDs"
      >
        <FormCheckbox
          label="Show human-readable object numbers"
          checked={humanIds}
          onChange={setHumanIds}
          hint="Turning this off hides the numbers in the UI; it does not delete them."
        />
      </SettingsCard>
    </>
  )
}

function DeviceFieldsSection() {
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ["device-field-visibility"],
    queryFn: () => api<DeviceFieldVisibility>("/api/deployment/device-fields/"),
  })
  const [fields, setFields] = useState<DeviceFieldVisibility | null>(null)
  useEffect(() => {
    if (data) setFields(data)
  }, [data])

  const save = useMutation({
    mutationFn: () =>
      api<DeviceFieldVisibility>("/api/deployment/device-fields/", {
        method: "PUT",
        body: JSON.stringify(fields),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["device-field-visibility"], d)
      qc.invalidateQueries({ queryKey: ["device-field-visibility"] })
      toast.success("Saved device fields")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!fields) return null
  return (
    <SettingsCard
      title="Device fields"
      description="Choose which optional built-in fields appear on the device form and detail page. Hidden fields are simply omitted — existing values are kept and shown again if you re-enable the field."
      onSave={() => save.mutate()}
      dirty={JSON.stringify(fields) !== JSON.stringify(data)}
      saving={save.isPending}
      saveLabel="Save device fields"
    >
      {DEVICE_FIELDS.map((f) => (
        <FormCheckbox
          key={f.key}
          label={f.label}
          checked={fields[f.key]}
          onChange={(v) => setFields({ ...fields, [f.key]: v })}
          hint={f.hint}
        />
      ))}
    </SettingsCard>
  )
}

function AdminTableRow({ table }: { table: TableMeta }) {
  const qc = useQueryClient()
  const pref = useTablePreference(table.id)
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["col-pref", table.id] })

  const publish = useMutation({
    mutationFn: (forced: boolean) =>
      putTableDefault(table.id, {
        order: pref.order,
        hidden: pref.hidden,
        forced,
      }),
    onSuccess: (_d, forced) => {
      toast.success(
        forced
          ? `Locked ${table.label} layout for the tenant`
          : `Published ${table.label} default`
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const clear = useMutation({
    mutationFn: () => deleteTableDefault(table.id),
    onSuccess: () => {
      toast.success(`Cleared ${table.label} default`)
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const busy = publish.isPending || clear.isPending

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{table.label}</div>
        <div className="text-[11px] text-muted-foreground">{table.area}</div>
      </div>
      {pref.isForced && (
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <Lock className="h-3 w-3" /> Locked
        </span>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(false)}
      >
        Publish my layout
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={busy}
        onClick={() => publish.mutate(!pref.isForced)}
      >
        {pref.isForced ? "Unlock" : "Lock"}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs text-destructive"
        disabled={busy}
        onClick={() => clear.mutate()}
      >
        Clear
      </Button>
    </div>
  )
}
