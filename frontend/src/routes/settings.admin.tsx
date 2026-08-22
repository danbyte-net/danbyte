import { useEffect, useRef, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DeploymentSettings } from "@/lib/api"
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
import { useDeploymentSettings } from "@/components/settings/use-deployment-settings"
import { apiErrorToast } from "@/lib/api-toast"
import { useTimezoneOptions } from "@/lib/use-timezones"

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
        to manage deployment settings.
      </p>
    )
  }
  return (
    <div className="space-y-6">
      <SettingsHeader title="General">
        Core identity, formats, and IDs for this whole install. Each card saves
        on its own - the button only writes the fields above it.
      </SettingsHeader>
      <SettingsGrid>
        <IdentityCard />
        <DateTimeCard />
        <HumanIdsCard />
      </SettingsGrid>
    </div>
  )
}

function IdentityCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [name, setName] = useState<string | null>(null)
  const [days, setDays] = useState<string | null>(null)

  useEffect(() => {
    if (data) {
      setName(data.deployment_name)
      setDays(String(data.changelog_retention_days))
    }
  }, [data])

  if (!data) return null
  return (
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
          "The app name - shown in the sidebar header, the browser tab title, " +
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
      <LogoField logoUrl={data.login_logo_url} />
    </SettingsCard>
  )
}

function DateTimeCard() {
  const timezoneOptions = useTimezoneOptions()
  const { data, save, savingKey } = useDeploymentSettings()
  const [dateFormat, setDateFormat] = useState<string>("YYYY-MM-DD")
  const [timeStyle, setTimeStyle] = useState<string>("24h")
  const [displayTz, setDisplayTz] = useState("")

  useEffect(() => {
    if (data) {
      setDateFormat(data.date_format)
      setTimeStyle(data.time_style)
      setDisplayTz(data.display_timezone)
    }
  }, [data])

  if (!data) return null
  return (
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
        options={timezoneOptions}
      />
    </SettingsCard>
  )
}

function HumanIdsCard() {
  const { data, save, savingKey } = useDeploymentSettings()
  const [humanIds, setHumanIds] = useState(true)

  useEffect(() => {
    if (data) setHumanIds(data.human_ids_enabled)
  }, [data])

  if (!data) return null
  return (
    <SettingsCard
      title="Human-readable IDs"
      description={
        <>
          Show a short per-tenant number (e.g. <span className="num">#27</span>)
          alongside each object's ID - handy when migrating from a tool whose
          integer IDs are printed on physical labels. Numbers are assigned per
          tenant, so each tenant counts from 1 independently.
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
  )
}

// Same file-not-field pattern as the favicon, for the login-page logo.
function LogoField({ logoUrl }: { logoUrl: string | null }) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<null | "upload" | "reset">(null)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deployment-email"] })
    qc.invalidateQueries({ queryKey: ["me"] })
  }

  const upload = async (file: File) => {
    setBusy("upload")
    try {
      const body = new FormData()
      body.append("logo", file)
      await api("/api/deployment/logo/", { method: "POST", body })
      refresh()
      toast.success("Logo updated")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  const reset = async () => {
    setBusy("reset")
    try {
      await api("/api/deployment/logo/", { method: "DELETE" })
      refresh()
      toast.success("Logo reset to the Danbyte default")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Field
      label="Login-page logo"
      hint="Shown above the sign-in form. A wide transparent PNG works best; max 2 MB. Blank = the Danbyte logo."
    >
      <div className="flex items-center gap-3">
        <img
          src={logoUrl || "/branding/logo-full.png"}
          alt=""
          className="h-8 max-w-48 rounded border border-border bg-background object-contain px-1.5 py-1"
        />
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
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
        {logoUrl && (
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
