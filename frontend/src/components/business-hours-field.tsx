import { Clock, Plus, X } from "lucide-react"

import type { BusinessHours } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormCombobox } from "@/components/forms"
import { useTimezoneOptions } from "@/lib/use-timezones"

// 0 = Monday, matching the weekday numbering the digest settings already use
// and what the API stores.
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

type Span = [string, string]

const DEFAULT_SPAN: Span = ["08:00", "17:00"]

const preset = (days: number[], spans: Span[]): BusinessHours =>
  Object.fromEntries(days.map((d) => [String(d), spans.map((s) => [...s] as Span)]))

const WEEKDAYS = preset([0, 1, 2, 3, 4], [DEFAULT_SPAN])
const ALWAYS = preset([0, 1, 2, 3, 4, 5, 6], [["00:00", "24:00"]])

/** When a party is reachable: spans per day plus the zone the times are in.
 *
 * A day holds a *list* of spans, because a break ("08:00-12:00, 13:00-17:00")
 * is routine for support desks in much of the world. The second span is one
 * click away rather than always on screen, so the common single-span day stays
 * a single row. */
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

  const setSpans = (day: number, spans: Span[]) => {
    const next = { ...value }
    if (spans.length) next[String(day)] = spans
    else delete next[String(day)]
    onChange(next)
  }
  const editSpan = (day: number, i: number, at: 0 | 1, time: string) => {
    const spans = (value[String(day)] ?? []).map((s) => [...s] as Span)
    if (!spans[i]) return
    spans[i][at] = time
    setSpans(day, spans)
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

        <div className="grid gap-2 rounded-md border border-border p-3">
          {DAYS.map((name, day) => {
            const spans = value[String(day)] ?? []
            const open = spans.length > 0
            return (
              <div key={name} className="flex items-start gap-2">
                <Checkbox
                  id={`${label}-${name}`}
                  className="mt-1.5"
                  checked={open}
                  onCheckedChange={(on) =>
                    setSpans(day, on ? [[...DEFAULT_SPAN]] : [])
                  }
                />
                <label
                  htmlFor={`${label}-${name}`}
                  className="mt-1 w-9 shrink-0 cursor-pointer text-xs"
                >
                  {name}
                </label>
                {open ? (
                  <div className="grid gap-1">
                    {spans.map((span, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <input
                          type="time"
                          value={span[0]}
                          onChange={(e) => editSpan(day, i, 0, e.target.value)}
                          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <span className="text-xs text-muted-foreground">to</span>
                        <input
                          type="time"
                          // The API's end-of-day sentinel has no clock face.
                          value={span[1] === "24:00" ? "23:59" : span[1]}
                          onChange={(e) => editSpan(day, i, 1, e.target.value)}
                          className="h-7 rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        {spans.length > 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            aria-label={`Remove this ${name} span`}
                            onClick={() =>
                              setSpans(
                                day,
                                spans.filter((_, x) => x !== i)
                              )
                            }
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground"
                            aria-label={`Add a second ${name} span`}
                            title="Add a break"
                            onClick={() =>
                              setSpans(day, [...spans, ["13:00", "17:00"]])
                            }
                          >
                            <Plus className="h-3 w-3" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="mt-1 text-xs text-muted-foreground">
                    Closed
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <FormCombobox
          label="Time zone"
          hint="required once hours are set"
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
