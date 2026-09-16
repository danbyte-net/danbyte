import { FormRow } from "@/components/forms/row"
import { FormSelect } from "@/components/forms/select"
import { FormText } from "@/components/forms/text"
import type { BackupCadence, BackupRetention } from "@/lib/api"

const FREQUENCIES = [
  { value: "hourly", label: "Hourly" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
]

const WEEKDAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
].map((label, i) => ({ value: String(i), label }))

export const DEFAULT_CADENCE: BackupCadence = {
  frequency: "daily",
  at: "02:00",
  weekday: 0,
  day: 1,
}

/** Frequency + wall-clock time + the weekday/day-of-month that applies.
 * Mirrors `core/cadence.Cadence`; the schedules page and, later, scripts
 * share it. */
export function CadenceFields({
  value,
  onChange,
}: {
  value: BackupCadence
  onChange: (next: BackupCadence) => void
}) {
  const set = (patch: Partial<BackupCadence>) =>
    onChange({ ...value, ...patch })
  return (
    <FormRow cols={3}>
      <FormSelect
        label="Frequency"
        value={value.frequency}
        onChange={(v) =>
          set({ frequency: (v ?? "daily") as BackupCadence["frequency"] })
        }
        options={FREQUENCIES}
      />
      <FormText
        label={value.frequency === "hourly" ? "Minute past the hour" : "At"}
        value={value.at}
        onChange={(v) => set({ at: v })}
        placeholder="02:00"
        mono
      />
      {value.frequency === "weekly" && (
        <FormSelect
          label="Weekday"
          value={String(value.weekday)}
          onChange={(v) => set({ weekday: Number(v ?? 0) })}
          options={WEEKDAYS}
        />
      )}
      {value.frequency === "monthly" && (
        <FormText
          label="Day of month"
          type="number"
          min={1}
          max={28}
          value={String(value.day)}
          onChange={(v) => set({ day: Number(v) || 1 })}
        />
      )}
    </FormRow>
  )
}

export function RetentionFields({
  value,
  onChange,
}: {
  value: BackupRetention
  onChange: (next: BackupRetention) => void
}) {
  const num = (v: string) => (v.trim() === "" ? null : Number(v))
  return (
    <FormRow cols={2}>
      <FormText
        label="Keep at most"
        type="number"
        min={1}
        value={value.max_count == null ? "" : String(value.max_count)}
        onChange={(v) => onChange({ ...value, max_count: num(v) })}
        placeholder="no limit"
      />
      <FormText
        label="Keep for days"
        type="number"
        min={1}
        value={value.max_age_days == null ? "" : String(value.max_age_days)}
        onChange={(v) => onChange({ ...value, max_age_days: num(v) })}
        placeholder="no limit"
      />
    </FormRow>
  )
}
