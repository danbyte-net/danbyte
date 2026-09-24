import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  HolidayCalendar,
  Paginated,
  SlaAgreement,
  SlaPeriod,
} from "@/lib/api"
import {
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
import { useSaveObject } from "@/lib/save-object"
import { PERIOD_LABEL } from "./sla-figure"

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

  const contacts = useQuery({
    queryKey: ["contacts-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/contacts/?picker=1"),
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
          customer,
          customer_name: customerName.trim(),
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
              <FormCombobox
                label="Customer"
                value={customer}
                onChange={setCustomer}
                options={(contacts.data?.results ?? []).map((c) => ({
                  value: c.id,
                  label: c.name,
                }))}
                noneLabel="None"
                placeholder="Pick a contact"
                searchPlaceholder="Search contacts…"
                emptyText="No contacts."
                error={fieldErrors.customer}
              />
              <FormText
                label="Customer name"
                value={customerName}
                onChange={setCustomerName}
                info="For a customer that is not a contact in Danbyte."
                error={fieldErrors.customer_name}
              />
            </div>
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
                    <Input
                      type="time"
                      className="h-8 w-28"
                      value={hours[d].from}
                      disabled={!hours[d].on}
                      onChange={(e) => setDay(d, { from: e.target.value })}
                      aria-label={`${label} from`}
                    />
                    <span className="text-muted-foreground">to</span>
                    <Input
                      type="time"
                      className="h-8 w-28"
                      value={hours[d].to}
                      disabled={!hours[d].on}
                      onChange={(e) => setDay(d, { to: e.target.value })}
                      aria-label={`${label} to`}
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
      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={a ? "Save" : "Create agreement"}
      />
    </form>
  )
}
