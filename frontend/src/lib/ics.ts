import { addDays, daysBetween, isIsoDate } from "@/lib/datetime"

// A reader for the all-day events of an iCalendar (.ics, RFC 5545) file - the
// format public holiday feeds and every calendar app export. Pure and
// dependency-free: it reads what a holiday list needs (dates, titles, a
// yearly repeat) and counts what it leaves out, so the caller can say so.

/** One all-day event, as bare `YYYY-MM-DD` dates. */
export interface IcsEvent {
  start: string
  /** Inclusive: a one-day event ends on its start. */
  end: string
  summary: string
  /** Repeats on its month and day every year, without end. */
  yearly: boolean
}

export interface IcsRead {
  events: IcsEvent[]
  /** Events with a time of day, not whole days. */
  timed: number
  /** Events whose repeat rule is not a plain yearly one. */
  repeating: number
  /** Events longer than a year, or with dates that do not parse. */
  other: number
}

/** The longest event read, in days. */
const MAX_SPAN = 366
/** A yearly event with an end is expanded into this many years at most. */
const MAX_YEARS = 100

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

/** `NAME;PARAM=x;PARAM="a:b":value` - the value starts at the first colon
 * outside a quoted parameter. */
function readProp(line: string): Prop | null {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') quoted = !quoted
    else if (c === ":" && !quoted) {
      colon = i
      break
    }
  }
  if (colon < 0) return null
  const parts: string[] = []
  let cur = ""
  quoted = false
  for (const c of line.slice(0, colon)) {
    if (c === '"') quoted = !quoted
    if (c === ";" && !quoted) {
      parts.push(cur)
      cur = ""
    } else cur += c
  }
  parts.push(cur)
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=")
    if (eq > 0)
      params[p.slice(0, eq).toUpperCase()] = p
        .slice(eq + 1)
        .replace(/^"|"$/g, "")
  }
  return {
    name: parts[0].trim().toUpperCase(),
    params,
    value: line.slice(colon + 1),
  }
}

function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) =>
    c === "n" || c === "N" ? " " : c
  )
}

/** "20261225" → "2026-12-25"; `null` when it is not a real date. */
function icsDate(v: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (!m) return null
  const iso = `${m[1]}-${m[2]}-${m[3]}`
  return isIsoDate(iso) ? iso : null
}

/** A DATE value, or a local-midnight DATE-TIME when `allDay` says the event
 * covers whole days (how Outlook writes all-day events). `timed` otherwise. */
function readDay(
  p: Prop | undefined,
  allDay: boolean
): string | null | "timed" {
  if (!p) return null
  const v = p.value.trim()
  const day = icsDate(v)
  if (day) return day
  const m = /^(\d{8})T(\d{6})Z?$/.exec(v)
  if (!m) return null
  if (allDay && m[2] === "000000") return icsDate(m[1])
  return "timed"
}

/** Whole days in an all-day DURATION: "P1D", "P2W", "P3DT0H0M0S". */
function durationDays(v: string): number | null {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:0+H)?(?:0+M)?(?:0+S)?)?$/i.exec(
    v.trim()
  )
  // An optional group that did not take part is undefined at run time.
  const [, weeks, days] = (m ?? []) as (string | undefined)[]
  if (weeks === undefined && days === undefined) return null
  return Number(weeks ?? 0) * 7 + Number(days ?? 0)
}

type Repeat =
  | { kind: "none" }
  | { kind: "yearly" }
  | { kind: "years"; count?: number; until?: string }
  | { kind: "other" }

/** Only a plain yearly repeat on the start's own month and day is followed:
 * anything else ("fourth Thursday of November") cannot be a fixed date. */
function readRepeat(rule: string | undefined, start: string): Repeat {
  if (!rule) return { kind: "none" }
  const parts: Partial<Record<string, string>> = {}
  for (const kv of rule.trim().split(";")) {
    const eq = kv.indexOf("=")
    if (eq > 0) parts[kv.slice(0, eq).toUpperCase()] = kv.slice(eq + 1).trim()
  }
  if (parts.FREQ?.toUpperCase() !== "YEARLY") return { kind: "other" }
  if ((parts.INTERVAL ?? "1") !== "1") return { kind: "other" }
  for (const k of ["BYDAY", "BYWEEKNO", "BYYEARDAY", "BYSETPOS"])
    if (parts[k] !== undefined) return { kind: "other" }
  const month = Number(start.slice(5, 7))
  const day = Number(start.slice(8, 10))
  if (parts.BYMONTH !== undefined && Number(parts.BYMONTH) !== month)
    return { kind: "other" }
  if (parts.BYMONTHDAY !== undefined && Number(parts.BYMONTHDAY) !== day)
    return { kind: "other" }
  if (parts.COUNT === undefined && parts.UNTIL === undefined)
    return { kind: "yearly" }
  const count = parts.COUNT !== undefined ? Number(parts.COUNT) : undefined
  if (count !== undefined && !(count >= 1)) return { kind: "other" }
  const until =
    parts.UNTIL !== undefined ? icsDate(parts.UNTIL.slice(0, 8)) : undefined
  if (until === null) return { kind: "other" }
  return { kind: "years", count, until }
}

/** `start` moved by whole years, keeping month and day; `null` when that day
 * does not exist in the year (29 February). */
function plusYears(iso: string, years: number): string | null {
  const y = Number(iso.slice(0, 4)) + years
  const moved = `${String(y).padStart(4, "0")}${iso.slice(4)}`
  return isIsoDate(moved) ? moved : null
}

/** The all-day events in an .ics file's text. Cancelled events and changed
 * single occurrences of a repeating event are left out. */
export function readAllDayEvents(text: string): IcsRead {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
  const out: IcsRead = { events: [], timed: 0, repeating: 0, other: 0 }
  let props: Prop[] | null = null
  let depth = 0
  for (const line of lines) {
    const upper = line.trim().toUpperCase()
    if (upper === "BEGIN:VEVENT") {
      props = []
      depth = 0
      continue
    }
    if (!props) continue
    // A VALARM inside the event has properties of its own.
    if (upper.startsWith("BEGIN:")) depth++
    else if (upper.startsWith("END:") && depth > 0) depth--
    else if (upper === "END:VEVENT") {
      readEvent(props, out)
      props = null
    } else if (depth === 0) {
      const p = readProp(line)
      if (p) props.push(p)
    }
  }
  return out
}

function readEvent(props: Prop[], out: IcsRead): void {
  const get = (name: string) => props.find((p) => p.name === name)
  if (get("STATUS")?.value.trim().toUpperCase() === "CANCELLED") return
  if (get("RECURRENCE-ID")) return
  const allDay =
    get("X-MICROSOFT-CDO-ALLDAYEVENT")?.value.trim().toUpperCase() === "TRUE"
  const start = readDay(get("DTSTART"), allDay)
  if (start === "timed") {
    out.timed++
    return
  }
  if (!start) {
    out.other++
    return
  }
  let end = start
  const dtend = readDay(get("DTEND"), allDay)
  const duration = get("DURATION")
  if (dtend === "timed") {
    out.timed++
    return
  }
  if (dtend) end = dtend > start ? addDays(dtend, -1) : start
  else if (duration) {
    const n = durationDays(duration.value)
    if (n === null) {
      out.timed++
      return
    }
    end = n > 1 ? addDays(start, n - 1) : start
  }
  if (daysBetween(start, end) >= MAX_SPAN) {
    out.other++
    return
  }
  const summary = unescapeText(get("SUMMARY")?.value ?? "").trim()
  const repeat = readRepeat(get("RRULE")?.value, start)
  if (repeat.kind === "other") {
    out.repeating++
    return
  }
  if (repeat.kind !== "years") {
    out.events.push({ start, end, summary, yearly: repeat.kind === "yearly" })
    return
  }
  // A yearly repeat that ends becomes one event per year it covers.
  const span = daysBetween(start, end)
  let made = 0
  for (let i = 0; i < MAX_YEARS; i++) {
    if (repeat.count !== undefined && made >= repeat.count) break
    const s = plusYears(start, i)
    if (s === null) continue
    if (repeat.until && s > repeat.until) break
    out.events.push({
      start: s,
      end: addDays(s, span),
      summary,
      yearly: false,
    })
    made++
  }
}
