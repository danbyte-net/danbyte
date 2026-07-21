import { createFileRoute } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { TABLES, type TableMeta } from "@/lib/tables"
import { api, type ColumnPrefSummary } from "@/lib/api"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { useTheme } from "@/components/theme-provider"
import { FormCheckbox, FormCombobox, FormSelect } from "@/components/forms"
import { Button } from "@/components/ui/button"
import { TwoFactorSection } from "@/components/two-factor-section"
import { ApiTokensSection } from "@/components/api-tokens-section"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/settings/preferences")({
  component: PreferencesPage,
})

function PreferencesPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader title="Preferences">
        Your account — how Danbyte looks for you, your sign-in, and your keys.
        These apply to you only, not the whole tenant.
      </SettingsHeader>
      <SettingsGrid>
        <DisplaySection />
        <TwoFactorSection />
        <ApiTokensSection />
      </SettingsGrid>
      {/* Full width: one row per table, so it'd leave a hole beside it. */}
      <TableLayoutsSection />
    </div>
  )
}

// One bulk request for the whole table list (instead of N per-table fetches —
// Django's dev server is single-threaded, so the fan-out made this page crawl).
function TableLayoutsSection() {
  const qc = useQueryClient()
  const summary = useQuery({
    queryKey: ["col-prefs-bulk"],
    queryFn: () =>
      api<Record<string, ColumnPrefSummary>>("/api/prefs/columns/"),
    staleTime: 60_000,
  })

  const reset = useMutation({
    mutationFn: (tableId: string) =>
      api(`/api/prefs/columns/${tableId}/`, { method: "DELETE" }),
    onSuccess: (_d, tableId) => {
      qc.invalidateQueries({ queryKey: ["col-prefs-bulk"] })
      qc.invalidateQueries({ queryKey: ["col-pref", tableId] })
      toast.success("Reset to tenant default")
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <SettingsCard
      title="Table layouts"
      description={
        <>
          Reorder and show/hide columns from the{" "}
          <span className="font-medium">Columns</span> menu on each table. Your
          choices are saved per table — there's nothing to save here. Reset one
          to fall back to the tenant default.
        </>
      }
    >
      <div className="divide-y rounded-lg border border-border">
        {TABLES.map((t) => (
          <TablePrefRow
            key={t.id}
            table={t}
            summary={summary.data?.[t.id]}
            onReset={() => reset.mutate(t.id)}
            resetting={reset.isPending}
          />
        ))}
      </div>
    </SettingsCard>
  )
}

// The tenant default is the "auto" value for the date/time settings — see
// auth_api.user_prefs (user override → tenant default → deployment default).
const AUTO = "auto"

const DATE_FORMAT_OPTIONS = [
  { value: "YYYY-MM-DD", label: "2026-01-31 (ISO)" },
  { value: "DD.MM.YYYY", label: "31.01.2026" },
  { value: "DD/MM/YYYY", label: "31/01/2026" },
  { value: "MM/DD/YYYY", label: "01/31/2026" },
  { value: "DD MMM YYYY", label: "31 Jan 2026" },
]

function timezoneOptions(): { value: string; label: string }[] {
  const zones =
    typeof Intl.supportedValuesOf === "function"
      ? Intl.supportedValuesOf("timeZone")
      : ["UTC"]
  return zones.map((z) => ({ value: z, label: z }))
}

function DisplaySection() {
  const { theme, toggleTheme } = useTheme()
  const { values, setPref } = useUserPrefs()
  const density = String(values.table_density ?? "comfortable")
  const stripes = values.table_stripes === true
  const pageSize = String(values.page_size ?? 25)
  const confirm = values.confirm_destructive !== false
  const timeFormat = String(values.time_format ?? "relative")
  const dateFormat = String(values.date_format ?? AUTO)
  const timeStyle = String(values.time_style ?? AUTO)
  const timezone = String(values.timezone ?? AUTO)
  const landing = String(values.landing_page ?? "/")
  const v4Max = String(values.space_map_v4_max ?? 31)
  const v6Max = String(values.space_map_v6_max ?? 128)

  return (
    <SettingsCard
      title="Display"
      description="How Danbyte looks and behaves for you. Every control here saves itself as you change it — there's no save button."
    >
      <div className="grid gap-4">
        <FormSelect
          label="Theme"
          value={theme}
          onChange={(v) => {
            if (v && v !== theme) toggleTheme()
          }}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <FormSelect
          label="Table density"
          value={density}
          onChange={(v) => v && setPref("table_density", v)}
          options={[
            { value: "comfortable", label: "Comfortable" },
            { value: "compact", label: "Compact" },
          ]}
        />
        <FormSelect
          label="Default page size"
          value={pageSize}
          onChange={(v) => v && setPref("page_size", Number(v))}
          options={[
            { value: "25", label: "25 rows" },
            { value: "50", label: "50 rows" },
            { value: "100", label: "100 rows" },
          ]}
        />
        <FormSelect
          label="Timestamps"
          hint="How dates show in tables — exact form is always on hover"
          value={timeFormat}
          onChange={(v) => v && setPref("time_format", v)}
          options={[
            { value: "relative", label: "Relative (3h ago)" },
            { value: "absolute", label: "Absolute (date & time)" },
          ]}
        />
        <FormSelect
          label="Date format"
          hint="How calendar dates render for you — Auto follows the tenant default"
          value={dateFormat}
          onChange={(v) => v && setPref("date_format", v)}
          options={[
            { value: AUTO, label: "Auto (tenant default)" },
            ...DATE_FORMAT_OPTIONS,
          ]}
        />
        <FormSelect
          label="Clock"
          value={timeStyle}
          onChange={(v) => v && setPref("time_style", v)}
          options={[
            { value: AUTO, label: "Auto (tenant default)" },
            { value: "24h", label: "24-hour (14:30)" },
            { value: "12h", label: "12-hour (2:30 PM)" },
          ]}
        />
        <FormCombobox
          label="Timezone"
          hint="Times render in this IANA timezone — Auto follows the tenant default"
          value={timezone === AUTO ? null : timezone}
          onChange={(v) => setPref("timezone", v ?? AUTO)}
          noneLabel="Auto (tenant default)"
          placeholder="Auto (tenant default)"
          searchPlaceholder="Search timezones…"
          options={timezoneOptions()}
        />
        <FormSelect
          label="Landing page"
          hint="Where Danbyte opens right after you log in"
          value={landing}
          onChange={(v) => v && setPref("landing_page", v)}
          options={[
            { value: "/", label: "Dashboard" },
            { value: "/prefixes", label: "Prefixes" },
            { value: "/ips", label: "IP addresses" },
            { value: "/devices", label: "Devices" },
            { value: "/monitoring", label: "Monitoring" },
            { value: "/alerts", label: "Alerts" },
          ]}
        />
        <FormSelect
          label="Space map depth — IPv4"
          hint="Deepest subnet the prefix map draws; click a cell to zoom deeper"
          value={v4Max}
          onChange={(v) => v && setPref("space_map_v4_max", Number(v))}
          options={[
            { value: "24", label: "/24" },
            { value: "25", label: "/25" },
            { value: "26", label: "/26" },
            { value: "27", label: "/27" },
            { value: "28", label: "/28" },
            { value: "29", label: "/29" },
            { value: "30", label: "/30" },
            { value: "31", label: "/31 (full)" },
          ]}
        />
        <FormSelect
          label="Space map depth — IPv6"
          hint="Deepest subnet the prefix map draws for IPv6"
          value={v6Max}
          onChange={(v) => v && setPref("space_map_v6_max", Number(v))}
          options={[
            { value: "48", label: "/48" },
            { value: "52", label: "/52" },
            { value: "56", label: "/56" },
            { value: "60", label: "/60" },
            { value: "64", label: "/64" },
            { value: "96", label: "/96" },
            { value: "120", label: "/120" },
            { value: "128", label: "/128 (full)" },
          ]}
        />
        <FormCheckbox
          label="Striped table rows"
          checked={stripes}
          onChange={(v) => setPref("table_stripes", v)}
        />
        <FormCheckbox
          label="Confirm before deleting"
          hint="Show a confirmation step on destructive actions"
          checked={confirm}
          onChange={(v) => setPref("confirm_destructive", v)}
        />
      </div>
    </SettingsCard>
  )
}

const SOURCE_LABEL: Record<string, string> = {
  user: "Customised",
  default: "Tenant default",
  tenant_forced: "Locked by admin",
  none: "Default",
}

function TablePrefRow({
  table,
  summary,
  onReset,
  resetting,
}: {
  table: TableMeta
  summary?: ColumnPrefSummary
  onReset: () => void
  resetting: boolean
}) {
  const source = summary?.source ?? "none"
  const isForced = summary?.is_forced ?? false
  const hasUserRow = summary?.has_user_row ?? false
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="font-medium">{table.label}</div>
        <div className="text-[11px] text-muted-foreground">{table.area}</div>
      </div>
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        {isForced && <Lock className="h-3 w-3" />}
        {SOURCE_LABEL[source] ?? "Default"}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-xs"
        disabled={!hasUserRow || isForced || resetting}
        onClick={onReset}
      >
        Reset
      </Button>
    </div>
  )
}
