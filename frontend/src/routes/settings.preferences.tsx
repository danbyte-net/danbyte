import { createFileRoute } from "@tanstack/react-router"
import { Lock } from "lucide-react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { TABLES, type TableMeta } from "@/lib/tables"
import { api, type ColumnPrefSummary } from "@/lib/api"
import { useUserPrefs } from "@/lib/use-user-prefs"
import { useTheme } from "@/components/theme-provider"
import { useLinkPrefs } from "@/components/link-prefs-provider"
import {
  FormCheckbox,
  FormColor,
  FormCombobox,
  FormSelect,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TwoFactorSection } from "@/components/two-factor-section"
import { ApiTokensSection } from "@/components/api-tokens-section"
import {
  SettingsCard,
  SettingsGrid,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"
import { useTimezoneOptions } from "@/lib/use-timezones"

export const Route = createFileRoute("/settings/preferences")({
  component: PreferencesPage,
})

// One card per subject, each with its own Save (the site-settings shape),
// instead of one tall Display card that saved every control as it changed.
// A card's draft is only what you touched; Save sends those keys together.
function PreferencesPage() {
  return (
    <div className="space-y-6">
      <SettingsHeader title="Preferences">
        Your account - how Danbyte looks for you, your sign-in, and your keys.
        These apply to you only, not the whole tenant.
      </SettingsHeader>
      <SettingsGrid>
        <AppearanceCard />
        <TablesCard />
        <DatesCard />
        <NavigationCard />
        <TaskEmailsCard />
        <SpaceMapCard />
        <TwoFactorSection />
        <ApiTokensSection />
      </SettingsGrid>
      {/* Full width: one row per table, so it'd leave a hole beside it. */}
      <TableLayoutsSection />
    </div>
  )
}

/** A card's unsaved edits over the server values: `get` reads the draft
 * first, `dirty` is true once a touched key differs, `save` sends the
 * touched keys in one request and clears the draft when it lands. */
function usePrefDraft() {
  const { values, setPrefs, saving } = useUserPrefs()
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const get = (key: string) => (key in draft ? draft[key] : values[key])
  const set = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }))
  const dirty = Object.keys(draft).some((k) => draft[k] !== values[k])
  const save = () => setPrefs(draft, () => setDraft({}))
  return { get, set, dirty, save, saving }
}

// The tenant default is the "auto" value for the date/time settings - see
// auth_api.user_prefs (user override → tenant default → deployment default).
const AUTO = "auto"

const DATE_FORMAT_OPTIONS = [
  { value: "YYYY-MM-DD", label: "2026-01-31 (ISO)" },
  { value: "DD.MM.YYYY", label: "31.01.2026" },
  { value: "DD/MM/YYYY", label: "31/01/2026" },
  { value: "MM/DD/YYYY", label: "01/31/2026" },
  { value: "DD MMM YYYY", label: "31 Jan 2026" },
]

// Theme and link styling live in the browser (providers, not server
// preferences) and apply as you pick them, so this card has no Save.
function AppearanceCard() {
  const { theme, toggleTheme } = useTheme()
  const { linkIcons, setLinkIcons, linkColor, setLinkColor } = useLinkPrefs()
  return (
    <SettingsCard
      title="Appearance"
      description="Applies as you change it - this browser only."
    >
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
      <FormCheckbox
        label="Show link icon on linked objects"
        hint="Adds a small chain glyph after links so clickable references stand out. Off keeps links as plain text that only underline on hover."
        checked={linkIcons}
        onChange={setLinkIcons}
      />
      <FormColor
        label="Link colour"
        hint="Colour used for links. Leave empty to keep them the same colour as text (underline on hover). Pick a hue if you want links to stand out - an accessibility aid."
        value={linkColor}
        onChange={setLinkColor}
      />
    </SettingsCard>
  )
}

function TablesCard() {
  const d = usePrefDraft()
  return (
    <SettingsCard
      title="Tables"
      description="Rows, paging and shading on every list."
      onSave={d.save}
      dirty={d.dirty}
      saving={d.saving}
    >
      <FormSelect
        label="Table density"
        value={String(d.get("table_density") ?? "comfortable")}
        onChange={(v) => v && d.set("table_density", v)}
        options={[
          { value: "comfortable", label: "Comfortable" },
          { value: "compact", label: "Compact" },
        ]}
      />
      <FormSelect
        label="Default page size"
        value={String(d.get("page_size") ?? 25)}
        onChange={(v) => v && d.set("page_size", Number(v))}
        // The same list the API accepts (auth_api.user_prefs.PAGE_SIZE_CHOICES);
        // a value outside it fell through to a blank picker.
        options={[10, 25, 50, 100, 250, 500, 1000, 2000].map((n) => ({
          value: String(n),
          label: `${n} rows`,
        }))}
      />
      <FormCheckbox
        label="Striped table rows"
        checked={d.get("table_stripes") === true}
        onChange={(v) => d.set("table_stripes", v)}
      />
    </SettingsCard>
  )
}

function DatesCard() {
  const d = usePrefDraft()
  const timezoneOptions = useTimezoneOptions()
  const timezone = String(d.get("timezone") ?? AUTO)
  return (
    <SettingsCard
      title="Dates and times"
      description="Auto follows the tenant default."
      onSave={d.save}
      dirty={d.dirty}
      saving={d.saving}
    >
      <FormSelect
        label="Timestamps"
        hint="How dates show in tables - exact form is always on hover"
        value={String(d.get("time_format") ?? "relative")}
        onChange={(v) => v && d.set("time_format", v)}
        options={[
          { value: "relative", label: "Relative (3h ago)" },
          { value: "absolute", label: "Absolute (date & time)" },
        ]}
      />
      <FormSelect
        label="Date format"
        value={String(d.get("date_format") ?? AUTO)}
        onChange={(v) => v && d.set("date_format", v)}
        options={[
          { value: AUTO, label: "Auto (tenant default)" },
          ...DATE_FORMAT_OPTIONS,
        ]}
      />
      <FormSelect
        label="Clock"
        value={String(d.get("time_style") ?? AUTO)}
        onChange={(v) => v && d.set("time_style", v)}
        options={[
          { value: AUTO, label: "Auto (tenant default)" },
          { value: "24h", label: "24-hour (14:30)" },
          { value: "12h", label: "12-hour (2:30 PM)" },
        ]}
      />
      <FormCombobox
        label="Timezone"
        hint="Times render in this IANA timezone"
        value={timezone === AUTO ? null : timezone}
        onChange={(v) => d.set("timezone", v ?? AUTO)}
        noneLabel="Auto (tenant default)"
        placeholder="Auto (tenant default)"
        searchPlaceholder="Search timezones…"
        options={timezoneOptions}
      />
    </SettingsCard>
  )
}

function NavigationCard() {
  const d = usePrefDraft()
  return (
    <SettingsCard
      title="Navigation"
      description="Where you land and how the menu folds."
      onSave={d.save}
      dirty={d.dirty}
      saving={d.saving}
    >
      <FormSelect
        label="Landing page"
        hint="Where Danbyte opens right after you log in"
        value={String(d.get("landing_page") ?? "/")}
        onChange={(v) => v && d.set("landing_page", v)}
        options={[
          { value: "/", label: "Dashboard" },
          { value: "/prefixes", label: "Prefixes" },
          { value: "/ips", label: "IP addresses" },
          { value: "/devices", label: "Devices" },
          { value: "/monitoring", label: "Monitoring" },
          { value: "/alerts", label: "Alerts" },
        ]}
      />
      <FormCheckbox
        label="One menu category open at a time"
        hint="Opening a category in the sidebar closes the others"
        checked={d.get("nav_one_open") === true}
        onChange={(v) => d.set("nav_one_open", v)}
      />
      <FormCheckbox
        label="Confirm before deleting"
        hint="Show a confirmation step on destructive actions"
        checked={d.get("confirm_destructive") !== false}
        onChange={(v) => d.set("confirm_destructive", v)}
      />
    </SettingsCard>
  )
}

function SpaceMapCard() {
  const d = usePrefDraft()
  return (
    <SettingsCard
      title="Space map"
      description="The deepest subnet the prefix map draws, per family."
      onSave={d.save}
      dirty={d.dirty}
      saving={d.saving}
    >
      <FormSelect
        label="IPv4"
        value={String(d.get("space_map_v4_max") ?? 31)}
        onChange={(v) => v && d.set("space_map_v4_max", Number(v))}
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
        label="IPv6"
        value={String(d.get("space_map_v6_max") ?? 128)}
        onChange={(v) => v && d.set("space_map_v6_max", Number(v))}
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
    </SettingsCard>
  )
}

function TaskEmailsCard() {
  const d = usePrefDraft()
  const on = (key: string) => d.get(key) !== false
  return (
    <SettingsCard
      title="Task emails"
      description="Personal mails about planning tasks - each kind can be switched off on its own."
      onSave={d.save}
      dirty={d.dirty}
      saving={d.saving}
    >
      <FormCheckbox
        label="Assigned to me"
        hint="Someone puts you on a task"
        checked={on("notify_task_assigned")}
        onChange={(v) => d.set("notify_task_assigned", v)}
      />
      <FormCheckbox
        label="My team's queue"
        hint="A task lands on one of your teams and nobody has claimed it"
        checked={on("notify_task_queue")}
        onChange={(v) => d.set("notify_task_queue", v)}
      />
      <FormCheckbox
        label="Comments"
        hint="A comment on a task you created, work on, or commented on"
        checked={on("notify_task_comments")}
        onChange={(v) => d.set("notify_task_comments", v)}
      />
      <FormCheckbox
        label="@mentions"
        hint="Someone @names you in a task comment"
        checked={on("notify_task_mentions")}
        onChange={(v) => d.set("notify_task_mentions", v)}
      />
      <FormCheckbox
        label="Daily work reminder"
        hint="Each morning: your overdue and upcoming tasks - only sent when you have some"
        checked={on("notify_task_due")}
        onChange={(v) => d.set("notify_task_due", v)}
      />
    </SettingsCard>
  )
}

// One bulk request for the whole table list (instead of N per-table fetches -
// Django's dev server is single-threaded, so the fan-out made this page crawl).
// Grouped by area with a filter, the same shape as the tenant's Table
// layouts page, so the two read as one thing seen from two sides.
function TableLayoutsSection() {
  const qc = useQueryClient()
  const [q, setQ] = useState("")
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

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (t: TableMeta) =>
      !needle ||
      t.label.toLowerCase().includes(needle) ||
      t.area.toLowerCase().includes(needle)
    const byArea = new Map<string, TableMeta[]>()
    for (const t of TABLES.filter(match)) {
      const list = byArea.get(t.area) ?? []
      list.push(t)
      byArea.set(t.area, list)
    }
    return [...byArea.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [q])
  const total = groups.reduce((n, [, list]) => n + list.length, 0)

  return (
    <SettingsCard
      title="Table layouts"
      description={
        <>
          Reorder and show/hide columns from the{" "}
          <span className="font-medium">Columns</span> menu on each table. Your
          choices are saved per table - there's nothing to save here. Reset one
          to fall back to the tenant default.
        </>
      }
      className="max-w-3xl"
    >
      <div className="flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter tables…"
          className="h-8 max-w-xs"
        />
        <span className="text-[11px] text-muted-foreground">
          {total} of {TABLES.length}
        </span>
      </div>
      {groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches.</p>
      ) : (
        groups.map(([area, list]) => (
          <div key={area} className="grid gap-1.5">
            <h3 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
              {area}
            </h3>
            <div className="divide-y divide-border rounded-md border border-border">
              {list.map((t) => (
                <TablePrefRow
                  key={t.id}
                  table={t}
                  summary={summary.data?.[t.id]}
                  onReset={() => reset.mutate(t.id)}
                  resetting={reset.isPending}
                />
              ))}
            </div>
          </div>
        ))
      )}
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
    <div className="flex items-center gap-3 px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1 truncate">{table.label}</span>
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
