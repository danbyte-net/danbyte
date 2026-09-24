import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  HolidayCalendar,
  Paginated,
  SlaAgreement,
  SlaBurnRule,
  SlaPeriod,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormDate,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { TimePicker } from "@/components/ui/time-picker"
import { useSaveObject } from "@/lib/save-object"
import { PERIOD_LABEL } from "./sla-figure"
import { BurnRulesEditor, DEFAULT_BURN_RULES } from "./sla-burn-rules"

const DAYS = [
  ["mon", "Monday"],
  ["tue", "Tuesday"],
  ["wed", "Wednesday"],
  ["thu", "Thursday"],
  ["fri", "Friday"],
  ["sat", "Saturday"],
  ["sun", "Sunday"],
] as const

type Hours = Record<string, { on: boolean; from: string; to: string }>

function hoursFrom(a?: SlaAgreement): Hours {
  const src = a?.service_hours ?? {}
  return Object.fromEntries(
    DAYS.map(([d], i) => {
      const span = (d in src ? src[d] : []).at(0)
      return [
        d,
        span
          ? { on: true, from: span[0], to: span[1] }
          : {
              on: i < 5 && !Object.keys(src).length,
              from: "08:00",
              to: "17:00",
            },
      ]
    })
  )
}

export function SlaAgreementForm({
  agreement,
  onSaved,
  onCancel,
}: {
  agreement?: SlaAgreement
  onSaved: (a: SlaAgreement) => void
  onCancel: () => void
}) {
  const a = agreement
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(a?.name ?? "")
  const [description, setDescription] = useState(a?.description ?? "")
  const [providedFor, setProvidedFor] = useState(a?.provided_for ?? "tenant")
  const [sites, setSites] = useState<string[]>(a?.sites ?? [])
  const [customer, setCustomer] = useState<string | null>(a?.customer ?? null)
  const [customerName, setCustomerName] = useState(a?.customer_name ?? "")
  const [target, setTarget] = useState(a?.target_pct ?? "99.9")
  const [warning, setWarning] = useState(a?.warning_pct ?? "")
  const [period, setPeriod] = useState<SlaPeriod>(a?.period ?? "month")
  const [tz, setTz] = useState(a?.timezone ?? "")
  const [status, setStatus] = useState(a?.status ?? "active")
  const [effective, setEffective] = useState(a?.effective_from ?? "")
  const [allDay, setAllDay] = useState(
    !a || Object.keys(a.service_hours).length === 0
  )
  const [hours, setHours] = useState<Hours>(() => hoursFrom(a))
  const [calendar, setCalendar] = useState<string | null>(
    a?.holiday_calendar ?? null
  )
  const [degraded, setDegraded] = useState(a?.count_degraded_as ?? "up")
  const [stale, setStale] = useState(a?.count_stale_as ?? "unmeasured")
  const [unknown, setUnknown] = useState(a?.count_unknown_as ?? "unmeasured")
  const [maint, setMaint] = useState(a?.exclude_maintenance ?? true)
  const [grace, setGrace] = useState(String(a?.min_outage_seconds ?? 0))
  const [aggregation, setAggregation] = useState(a?.aggregation ?? "mean")
  const [channels, setChannels] = useState<string[]>(a?.notify_channels ?? [])
  const [burn, setBurn] = useState(
    a?.alert_burn_rate != null ? String(a.alert_burn_rate) : ""
  )
  const [burnRules, setBurnRules] = useState<SlaBurnRule[]>(
    a?.burn_alerts.length ? a.burn_alerts : DEFAULT_BURN_RULES
  )
  const [coverageAlert, setCoverageAlert] = useState(
    a?.alert_coverage_pct ?? ""
  )
  const [objectives, setObjectives] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(a?.latency_objectives ?? {}).map(([k, v]) => [
        k,
        String(v),
      ])
    )
  )
  const [recipients, setRecipients] = useState(
    (a?.report_recipients ?? []).join("\n")
  )
  const [reportFormat, setReportFormat] = useState(a?.report_format ?? "pdf")

  const contacts = useQuery({
    queryKey: ["contacts-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/contacts/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const channelList = useQuery({
    queryKey: ["notification-channels", "sla"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string; kind: string }>>(
        "/api/monitoring/channels/?page_size=200"
      ),
  })
  const siteOptions = useQuery({
    queryKey: ["sites", "sla-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?picker=1"),
    enabled: providedFor === "sites",
    staleTime: 5 * 60_000,
  })
  const calendars = useQuery({
    queryKey: ["holiday-calendars"],
    queryFn: () =>
      api<Paginated<HolidayCalendar>>(
        "/api/monitoring/holiday-calendars/?page_size=200"
      ),
  })

  const save = useMutation({
    mutationFn: () => {
      reset()
      const service_hours = allDay
        ? {}
        : Object.fromEntries(
            DAYS.filter(([d]) => hours[d].on).map(([d]) => [
              d,
              [[hours[d].from, hours[d].to]],
            ])
          )
      return saveObject<SlaAgreement>({
        objectType: "monitoring.slaagreement",
        endpoint: "/api/monitoring/sla-agreements/",
        id: a?.id,
        payload: {
          name: name.trim(),
          description,
          provided_for: providedFor,
          sites: providedFor === "sites" ? sites : [],
          customer: providedFor === "contact" ? customer : null,
          customer_name: providedFor === "name" ? customerName.trim() : "",
          target_pct: target,
          warning_pct: warning || null,
          period,
          timezone: tz.trim(),
          status,
          effective_from: effective || null,
          service_hours,
          holiday_calendar: calendar,
          count_degraded_as: degraded,
          count_stale_as: stale,
          count_unknown_as: unknown,
          exclude_maintenance: maint,
          min_outage_seconds: Number(grace) || 0,
          aggregation,
          notify_channels: channels,
          alert_burn_rate: burn ? Number(burn) : null,
          burn_alerts: burnRules,
          alert_coverage_pct: coverageAlert || null,
          latency_objectives: Object.fromEntries(
            Object.entries(objectives)
              .filter(([, v]) => v.trim() !== "")
              .map(([k, v]) => [k, Number(v)])
          ),
          report_recipients: recipients
            .split(/[\s,]+/)
            .map((x) => x.trim())
            .filter(Boolean),
          report_format: reportFormat,
        },
      })
    },
    onSuccess: (saved) => {
      toast.success(a ? `Updated ${name}` : `Created ${name}`)
      qc.invalidateQueries({ queryKey: ["sla-agreements"] })
      qc.invalidateQueries({ queryKey: ["sla-agreement"] })
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const setDay = (d: string, patch: Partial<Hours[string]>) =>
    setHours((h) => ({ ...h, [d]: { ...h[d], ...patch } }))

  return (
    <form
      className="@container grid gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate()
      }}
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Agreement" card>
            <FormText
              label="Name"
              value={name}
              onChange={setName}
              required
              placeholder="Gold - data centre"
              error={fieldErrors.name}
            />
            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Provided for"
                value={providedFor}
                onChange={(v) => setProvidedFor(v as typeof providedFor)}
                options={[
                  { value: "tenant", label: "This tenant" },
                  { value: "sites", label: "Sites" },
                  { value: "contact", label: "A contact" },
                  { value: "name", label: "A name" },
                ]}
                info="Who the promise is made to. Often the tenant itself; or some of its sites or locations; or a contact or a name outside Danbyte."
                error={fieldErrors.provided_for}
              />
              {providedFor === "contact" && (
                <FormCombobox
                  label="Contact"
                  required
                  value={customer}
                  onChange={setCustomer}
                  options={(contacts.data?.results ?? []).map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                  placeholder="Pick a contact"
                  searchPlaceholder="Search contacts…"
                  emptyText="No contacts."
                  error={fieldErrors.customer}
                />
              )}
              {providedFor === "name" && (
                <FormText
                  label="Name"
                  required
                  value={customerName}
                  onChange={setCustomerName}
                  placeholder="Acme A/S"
                  error={fieldErrors.customer_name}
                />
              )}
            </div>
            {providedFor === "sites" && (
              <Field label="Sites" required error={fieldErrors.sites}>
                <CheckList
                  options={(siteOptions.data?.results ?? []).map((o) => ({
                    value: o.id,
                    label: o.name,
                  }))}
                  value={sites}
                  onChange={setSites}
                  className="max-h-40"
                  empty="No sites."
                />
              </Field>
            )}
            <FormTextarea
              label="Description"
              value={description}
              onChange={setDescription}
              rows={2}
              error={fieldErrors.description}
            />
            <FormSelect
              label="Status"
              value={status}
              onChange={(v) => setStatus(v as typeof status)}
              options={[
                { value: "active", label: "Active" },
                { value: "draft", label: "Draft" },
                { value: "archived", label: "Archived" },
              ]}
              info="Only active agreements are computed. Archived ones keep their history."
              error={fieldErrors.status}
            />
          </FormSection>

          <FormSection title="Target" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Target"
                type="number"
                value={target}
                onChange={setTarget}
                required
                inputMode="decimal"
                info="Availability promised over the period, in percent."
                error={fieldErrors.target_pct}
              />
              <FormText
                label="At risk below"
                type="number"
                value={warning}
                onChange={setWarning}
                inputMode="decimal"
                info="Empty: at risk once three quarters of the error budget is spent."
                error={fieldErrors.warning_pct}
              />
              <FormSelect
                label="Period"
                value={period}
                onChange={(v) => setPeriod(v as SlaPeriod)}
                options={Object.entries(PERIOD_LABEL).map(([value, label]) => ({
                  value,
                  label,
                }))}
                error={fieldErrors.period}
              />
              <FormDate
                label="Counts from"
                value={effective}
                onChange={setEffective}
                info="Nothing before this date is computed."
                error={fieldErrors.effective_from}
              />
            </div>
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Service hours" card>
            <FormCheckbox
              label="Around the clock"
              checked={allDay}
              onChange={setAllDay}
            />
            {!allDay && (
              <div className="grid gap-1.5">
                {DAYS.map(([d, label]) => (
                  <div key={d} className="flex items-center gap-2 text-[13px]">
                    <label className="flex w-32 items-center gap-2">
                      <Checkbox
                        checked={hours[d].on}
                        onCheckedChange={(v) => setDay(d, { on: v === true })}
                      />
                      {label}
                    </label>
                    <TimePicker
                      className="h-8 w-28"
                      value={hours[d].from}
                      disabled={!hours[d].on}
                      onChange={(v) => v && setDay(d, { from: v })}
                    />
                    <span className="text-muted-foreground">to</span>
                    <TimePicker
                      className="h-8 w-28"
                      value={hours[d].to}
                      disabled={!hours[d].on}
                      onChange={(v) => v && setDay(d, { to: v })}
                    />
                  </div>
                ))}
                {fieldErrors.service_hours && (
                  <p className="text-xs text-destructive">
                    {fieldErrors.service_hours}
                  </p>
                )}
              </div>
            )}
            <div className="grid gap-3 @md:grid-cols-2">
              <FormCombobox
                label="Holidays"
                value={calendar}
                onChange={setCalendar}
                options={(calendars.data?.results ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
                noneLabel="None"
                placeholder="Pick a calendar"
                emptyText="No holiday calendars yet."
                info="Days in the calendar are not measured."
                error={fieldErrors.holiday_calendar}
              />
              <FormText
                label="Timezone"
                value={tz}
                onChange={setTz}
                placeholder="Europe/Copenhagen"
                info="Periods and service hours are read in this zone. Empty: the tenant's."
                error={fieldErrors.timezone}
              />
            </div>
          </FormSection>

          <FormSection title="Counting" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Degraded counts as"
                value={degraded}
                onChange={(v) => setDegraded(v as typeof degraded)}
                options={[
                  { value: "up", label: "Up" },
                  { value: "down", label: "Down" },
                ]}
              />
              <FormSelect
                label="Stale counts as"
                value={stale}
                onChange={(v) => setStale(v as typeof stale)}
                options={[
                  { value: "unmeasured", label: "Not measured" },
                  { value: "down", label: "Down" },
                ]}
                info="Stale means the probe could not see the target - usually the probe's fault, not the service's."
              />
              <FormSelect
                label="Unknown counts as"
                value={unknown}
                onChange={(v) => setUnknown(v as typeof unknown)}
                options={[
                  { value: "unmeasured", label: "Not measured" },
                  { value: "down", label: "Down" },
                ]}
              />
              <FormSelect
                label="Members combine as"
                value={aggregation}
                onChange={(v) => setAggregation(v as typeof aggregation)}
                options={[
                  { value: "mean", label: "Average" },
                  { value: "worst", label: "Worst member" },
                ]}
              />
              <Field
                label="Ignore outages under"
                info="Shorter outages count as up. Seconds."
                error={fieldErrors.min_outage_seconds}
              >
                <Input
                  type="number"
                  min={0}
                  value={grace}
                  onChange={(e) => setGrace(e.target.value)}
                />
              </Field>
            </div>
            <FormCheckbox
              label="Exclude planned maintenance"
              checked={maint}
              onChange={setMaint}
              info="Confirmed maintenance events on a member's device do not count."
            />
          </FormSection>
        </FormColumn>
      </FormColumns>
      <FormSection title="Alerts and reports" card>
        <div className="grid gap-4 @3xl:grid-cols-2">
          <div className="grid gap-3">
            <Field
              label="Alert channels"
              info="At risk, breached, coverage low and a missed latency objective - each at most once per period. Burn-rate alerts when they start and stop."
              error={fieldErrors.notify_channels}
            >
              <CheckList
                options={(channelList.data?.results ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                  hint: c.kind,
                }))}
                value={channels}
                onChange={setChannels}
                className="max-h-32"
                empty="No notification channels yet."
              />
            </Field>
            <Field
              label="Burn-rate alerts"
              info="Alert while the budget burns this many times faster than the target allows, over both windows. The long window proves it is real, the short one that it is still happening."
              error={fieldErrors.burn_alerts}
            >
              <BurnRulesEditor value={burnRules} onChange={setBurnRules} />
            </Field>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="At risk above burn rate"
                type="number"
                inputMode="decimal"
                value={burn}
                onChange={setBurn}
                placeholder="2"
                info="How many times faster than time passes the budget may burn. 1 spends it exactly by the period's end."
                error={fieldErrors.alert_burn_rate}
              />
              <FormText
                label="Coverage alert below"
                type="number"
                inputMode="decimal"
                value={coverageAlert}
                onChange={setCoverageAlert}
                placeholder="90"
                info="Alert when less of the service time than this, in percent, was measured."
                error={fieldErrors.alert_coverage_pct}
              />
            </div>
            <Field
              label="Latency objectives"
              info="p95 per check kind, in ms, over the period. Missing one alerts; it never lowers availability."
              error={fieldErrors.latency_objectives}
            >
              <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">
                {["icmp", "tcp", "http", "ssh"].map((kind) => (
                  <label key={kind} className="grid gap-1 text-xs">
                    <span className="font-mono text-muted-foreground uppercase">
                      {kind}
                    </span>
                    <Input
                      type="number"
                      min={0}
                      value={objectives[kind] ?? ""}
                      onChange={(e) =>
                        setObjectives((o) => ({ ...o, [kind]: e.target.value }))
                      }
                      aria-label={`${kind} p95 objective`}
                    />
                  </label>
                ))}
              </div>
            </Field>
          </div>
          <div className="grid gap-3">
            <FormTextarea
              label="Report recipients"
              value={recipients}
              onChange={setRecipients}
              rows={4}
              placeholder={"noc@example.com\ncustomer@example.com"}
              info="Each period's report is emailed here when the period freezes, seven days after it ends."
              error={fieldErrors.report_recipients}
            />
            <FormSelect
              label="Report as"
              value={reportFormat}
              onChange={(v) => setReportFormat(v as typeof reportFormat)}
              options={[
                { value: "pdf", label: "PDF" },
                { value: "csv", label: "CSV" },
                { value: "both", label: "PDF and CSV" },
              ]}
            />
          </div>
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={a ? "Save" : "Create agreement"}
      />
    </form>
  )
}
