import { Clock } from "lucide-react"

import type { BusinessHours } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormCombobox } from "@/components/forms"
import { useTimezoneOptions } from "@/lib/use-timezones"

// 0 = Monday, matching the weekday numbering the digest settings already use
// and what the API stores.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const WEEKDAYS: BusinessHours = Object.fromEntries(
  [0, 1, 2, 3, 4].map((d) => [String(d), ["08:00", "17:00"] as [string, string]])
)
const ALWAYS: BusinessHours = Object.fromEntries(
  [0, 1, 2, 3, 4, 5, 6].map((d) => [
    String(d),
    ["00:00", "24:00"] as [string, string],
  ])
)

/** When a party is reachable: a row per day plus the zone the times are in.
 *
 * One span per day on purpose - the field answers "can I call them", not
 * "roster them". The two presets cover the shapes almost every record has, so
 * the common case is one click rather than seven rows of typing. */
export function BusinessHoursField({
  label,
  hint,
  value,
  tz,
  onChange,
  onTzChange,
  error,
}: {
  label: string
  hint?: string
  value: BusinessHours
  tz: string
  onChange: (next: BusinessHours) => void
  onTzChange: (next: string) => void
  error?: string
}) {
  const timezones = useTimezoneOptions()
  const setDay = (day: number, span: [string, string] | null) => {
    const next = { ...value }
    if (span) next[String(day)] = span
    else delete next[String(day)]
    onChange(next)
  }
  const anySet = Object.keys(value).length > 0

  return (
    <Field label={label} hint={hint} error={error}>
      <div className="grid gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => onChange(WEEKDAYS)}
          >
            Mon-Fri 08-17
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
            onClick={() => onChange(ALWAYS)}
          >
            24/7
          </Button>
          {anySet && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px] text-muted-foreground"
              onClick={() => onChange({})}
            >
              Clear
            </Button>
          )}
        </div>

        <div className="grid gap-1.5 rounded-md border border-border p-3">
          {DAYS.map((name, day) => {
            const span = value[String(day)]
            return (
              <div key={name} className="flex items-center gap-2">
                <Checkbox
                  id={`${label}-${name}`}
                  checked={!!span}
                  onCheckedChange={(on) =>
                    setDay(day, on ? ["08:00", "17:00"] : null)
                  }
                />
                <label
                  htmlFor={`${label}-${name}`}
                  className="w-9 shrink-0 cursor-pointer text-xs"
                >
                  {name}
                </label>
                {span ? (
                  <>
                    <input
                      type="time"
                      value={span[0]}
                      onChange={(e) => setDay(day, [e.target.value, span[1]])}
                      className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                    <span className="text-xs text-muted-foreground">to</span>
                    <input
                      type="time"
                      value={span[1] === "24:00" ? "23:59" : span[1]}
                      onChange={(e) => setDay(day, [span[0], e.target.value])}
                      className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    />
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">Closed</span>
                )}
              </div>
            )
          })}
        </div>

        <FormCombobox
          label="Time zone"
          hint="the zone these times are stated in"
          value={tz || null}
          onChange={(v) => onTzChange(v ?? "")}
          options={timezones}
          noneLabel="Not set"
          placeholder="Select a time zone…"
          searchPlaceholder="Search zones…"
          emptyText="No zones."
        />
      </div>
    </Field>
  )
}

/** The read side: the one-line summary plus whether they are reachable now.
 * Null `openNow` stays unlabelled - "we don't know their hours" must not look
 * like "closed". */
export function BusinessHoursSummary({
  display,
  openNow,
}: {
  display: string
  openNow: boolean | null
}) {
  if (!display) return <span className="text-muted-foreground">-</span>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
        {display}
      </span>
      {openNow !== null && (
        <Badge variant={openNow ? "success" : "secondary"}>
          {openNow ? "Open now" : "Outside hours"}
        </Badge>
      )}
    </span>
  )
}
