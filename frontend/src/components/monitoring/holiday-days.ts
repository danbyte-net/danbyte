import type { DateFormat, HolidayDay } from "@/lib/api"
import { addDays, daysBetween, isIsoDate } from "@/lib/datetime"
import type { IcsEvent } from "@/lib/ics"

// The days of a holiday calendar, as the editor works on them. Pure, and the
// same rules the server applies when it saves (monitoring/sla_api.py):
//
// 1. one one-off day per date;
// 2. one yearly day per month and day - it repeats in every year, earlier
//    ones included, and a yearly 29 February falls in leap years only;
// 3. a one-off on a yearly day's month and day folds into the yearly one;
// 4. the first name given wins;
// 5. sorted by date.
//
// Dates are bare `YYYY-MM-DD` strings throughout, and every weekday or step
// is counted in UTC: `new Date(iso).getDay()` is the day before west of UTC.

/** A calendar holds at most this many days. */
export const MAX_DAYS = 1000
/** A day's name is at most this long. */
export const NAME_MAX = 100
/** The years the editor steps through, and the server takes. */
export const MIN_YEAR = 1970
export const MAX_YEAR = 2099
/** The longest range a paste expands, in days. */
const MAX_RANGE = 366

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const WEEKDAY_LONG = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]
export const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

const monthDay = (iso: string) => iso.slice(5)
const yearOf = (iso: string) => Number(iso.slice(0, 4))
const utcDay = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()
const pad = (n: number, w = 2) => String(n).padStart(w, "0")
const YEARS = `${MIN_YEAR}–${MAX_YEAR}`
const plural = (n: number, one: string) =>
  `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`

export const yearInRange = (y: number) => y >= MIN_YEAR && y <= MAX_YEAR

/** A yearly day's stored year means nothing, so one outside the range moves
 * to the nearest year in it that has its month and day (29 February: a
 * leap year). */
function intoRange(iso: string): string {
  const y = yearOf(iso)
  if (yearInRange(y)) return iso
  const step = y < MIN_YEAR ? 1 : -1
  let to = y < MIN_YEAR ? MIN_YEAR : MAX_YEAR
  for (let i = 0; i < 8; i++, to += step) {
    const moved = `${pad(to, 4)}-${monthDay(iso)}`
    if (isIsoDate(moved)) return moved
  }
  return iso
}

/** The row key: a one-off day's date, or "y-MM-DD" for a yearly day. */
export function dayKey(d: HolidayDay): string {
  return d.yearly ? `y-${monthDay(d.date)}` : d.date
}

/** Rules 1-5 above, over days in the order given. */
export function normaliseDays(days: HolidayDay[]): HolidayDay[] {
  const yearly = new Map<string, HolidayDay>()
  for (const d of days) {
    if (!d.yearly) continue
    const cur = yearly.get(monthDay(d.date))
    if (!cur) yearly.set(monthDay(d.date), { ...d })
    else if (!cur.name) cur.name = d.name
  }
  const once = new Map<string, HolidayDay>()
  for (const d of days) {
    if (d.yearly) continue
    const every = yearly.get(monthDay(d.date))
    if (every) {
      if (!every.name) every.name = d.name
      continue
    }
    const cur = once.get(d.date)
    if (!cur) once.set(d.date, { ...d })
    else if (!cur.name) cur.name = d.name
  }
  return [...once.values(), ...yearly.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  )
}

/** What makes `iso` a holiday: its one-off day, else a yearly day on its
 * month and day. */
export function holidayOn(
  days: HolidayDay[],
  iso: string
): HolidayDay | undefined {
  return (
    days.find((d) => !d.yearly && d.date === iso) ??
    days.find((d) => d.yearly && monthDay(d.date) === monthDay(iso))
  )
}

/** Click on a day: take off what makes it a holiday (a yearly day goes for
 * every year), or make it a one-off holiday. */
export function toggleDay(days: HolidayDay[], iso: string): HolidayDay[] {
  const hit = holidayOn(days, iso)
  if (hit) return days.filter((d) => d !== hit)
  return normaliseDays([...days, { date: iso, name: "", yearly: false }])
}

/** "Every year" on or off for the day with `key`. On folds one-off days on
 * the same month and day into it; off keeps the day shown (`shownIso`, in
 * the year in view) as a one-off, so the row stays where it is. */
export function setYearly(
  days: HolidayDay[],
  key: string,
  on: boolean,
  shownIso: string
): HolidayDay[] {
  const hit = days.find((d) => dayKey(d) === key)
  if (!hit || hit.yearly === on) return days
  const rest = days.filter((d) => d !== hit)
  const moved = on
    ? { ...hit, yearly: true }
    : { ...hit, date: shownIso, yearly: false }
  return normaliseDays([moved, ...rest])
}

export function renameDay(
  days: HolidayDay[],
  key: string,
  name: string
): HolidayDay[] {
  return days.map((d) =>
    dayKey(d) === key ? { ...d, name: name.slice(0, NAME_MAX) } : d
  )
}

export function removeDay(days: HolidayDay[], key: string): HolidayDay[] {
  return days.filter((d) => dayKey(d) !== key)
}

/** The holidays that fall in `year`, yearly ones included, by date. */
export function daysInYear(
  days: HolidayDay[],
  year: number
): { iso: string; day: HolidayDay }[] {
  const out = new Map<string, HolidayDay>()
  for (const d of days) {
    const iso = d.yearly ? `${pad(year, 4)}-${monthDay(d.date)}` : d.date
    if (d.yearly ? !isIsoDate(iso) : yearOf(iso) !== year) continue
    // A one-off day wins its date (they cannot both be there once saved).
    if (!out.has(iso) || !d.yearly) out.set(iso, d)
  }
  return [...out.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([iso, day]) => ({ iso, day }))
}

export interface Merged {
  days: HolidayDay[]
  /** Days that were not there before. */
  added: number
  /** Days that were there and got a name. */
  named: number
  /** The years one-off additions fall in, ascending. */
  years: number[]
  /** Yearly days added. */
  yearly: number
}

/** `incoming` added to `days`. Days already there win; they take a name from
 * the incoming day only when they had none. */
export function mergeDays(days: HolidayDay[], incoming: HolidayDay[]): Merged {
  const before = new Map(days.map((d) => [dayKey(d), d]))
  const merged = normaliseDays([...days, ...incoming])
  let added = 0
  let named = 0
  let yearly = 0
  const years = new Set<number>()
  for (const d of merged) {
    const was = before.get(dayKey(d))
    if (!was) {
      added++
      if (d.yearly) yearly++
      else years.add(yearOf(d.date))
    } else if (!was.name && d.name) named++
  }
  return {
    days: merged,
    added,
    named,
    yearly,
    years: [...years].sort((a, b) => a - b),
  }
}

// ─── pasting ────────────────────────────────────────────────────────────────

const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3).toLowerCase())

/** The date shapes a paste reads: ISO always, and the user's own format. */
function datePatterns(
  format?: DateFormat
): { re: RegExp; iso: (m: RegExpExecArray) => string }[] {
  const iso = {
    re: /(\d{4})-(\d{2})-(\d{2})/g,
    iso: (m: RegExpExecArray) => `${m[1]}-${m[2]}-${m[3]}`,
  }
  const dmy = (sep: string) => ({
    re: new RegExp(`(\\d{1,2})\\${sep}(\\d{1,2})\\${sep}(\\d{4})`, "g"),
    iso: (m: RegExpExecArray) => `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`,
  })
  switch (format) {
    case "DD.MM.YYYY":
      return [iso, dmy(".")]
    case "DD/MM/YYYY":
      return [iso, dmy("/")]
    case "MM/DD/YYYY":
      return [
        iso,
        {
          re: /(\d{1,2})\/(\d{1,2})\/(\d{4})/g,
          iso: (m) => `${m[3]}-${pad(+m[1])}-${pad(+m[2])}`,
        },
      ]
    case "DD MMM YYYY":
      return [
        iso,
        {
          re: /(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/g,
          iso: (m) => {
            const i = MONTH_SHORT.indexOf(m[2].toLowerCase())
            return i < 0
              ? `${m[3]}-00-00`
              : `${m[3]}-${pad(i + 1)}-${pad(+m[1])}`
          },
        },
      ]
    default:
      return [iso]
  }
}

/** The formats a paste reads, for the field's explanation. */
export function pasteFormats(format?: DateFormat): string {
  return format && format !== "YYYY-MM-DD"
    ? `YYYY-MM-DD or ${format}`
    : "YYYY-MM-DD"
}

const SEPARATORS = /^[\s,;:|–—-]+|[\s,;:|–—-]+$/g
/** What between two dates makes them a range: "2026-12-24 – 2026-12-26". */
const RANGE = /^\s*(?:[–—-]|to|until|till|through)\s*$/i

const cleanName = (s: string) =>
  s.replace(/\s+/g, " ").replace(SEPARATORS, "").slice(0, NAME_MAX)

interface Hit {
  at: number
  end: number
  iso: string
  raw: string
}

/** Dates typed or pasted: any number per line, separated by anything, and
 * "date – date" ranges, which add each day. Text beside a line's only date
 * or range names it ("2026-12-25 Christmas Day", "Christmas Day: 2026-12-25").
 * With several, the text before each names it when the line starts with
 * text ("Christmas 2026-12-25, Boxing 2026-12-26"), else the text after. */
export function parsePasted(
  text: string,
  format?: DateFormat
): { days: HolidayDay[]; errors: string[] } {
  const days: HolidayDay[] = []
  const errors: string[] = []
  const patterns = datePatterns(format)
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    const where = `Line ${i + 1}`
    const hits: Hit[] = []
    for (const p of patterns) {
      p.re.lastIndex = 0
      for (let m = p.re.exec(line); m; m = p.re.exec(line)) {
        const at = m.index
        const end = at + m[0].length
        if (hits.some((h) => at < h.end && end > h.at)) continue
        hits.push({ at, end, iso: p.iso(m), raw: m[0] })
      }
    }
    if (hits.length === 0) {
      errors.push(`${where}: no date.`)
      return
    }
    hits.sort((a, b) => a.at - b.at)
    const items: { from: Hit; to: Hit }[] = []
    for (let j = 0; j < hits.length; j++) {
      const next = hits[j + 1] as Hit | undefined
      if (next && RANGE.test(line.slice(hits[j].end, next.at))) {
        items.push({ from: hits[j], to: next })
        j++
      } else items.push({ from: hits[j], to: hits[j] })
    }
    const lead = cleanName(line.slice(0, items[0].from.at)) !== ""
    items.forEach(({ from, to }, j) => {
      const name = cleanName(
        items.length === 1
          ? line.slice(0, from.at) + " " + line.slice(to.end)
          : lead
            ? line.slice(j ? items[j - 1].to.end : 0, from.at)
            : line.slice(to.end, items[j + 1]?.from.at ?? line.length)
      )
      const bad = [from, to].find((h) => !isIsoDate(h.iso))
      if (bad) {
        errors.push(`${where}: «${bad.raw}» is not a date.`)
        return
      }
      const outside = [from, to].find((h) => !yearInRange(yearOf(h.iso)))
      if (outside) {
        errors.push(`${where}: ${yearOf(outside.iso)} is outside ${YEARS}.`)
        return
      }
      const span = daysBetween(from.iso, to.iso)
      if (span < 0) {
        errors.push(
          `${where}: «${line.slice(from.at, to.end)}» ends before it starts.`
        )
        return
      }
      if (span >= MAX_RANGE) {
        errors.push(`${where}: a range is longer than a year.`)
        return
      }
      for (let d = from.iso; d <= to.iso; d = addDays(d, 1))
        days.push({ date: d, name, yearly: false })
    })
  })
  return { days, errors }
}

/** Every day of each event: a three-day event is three holidays. Days in a
 * year the editor cannot show are left out and counted in `outside`; a
 * yearly day keeps its month and day in a year it can. */
export function daysFromIcs(events: IcsEvent[]): {
  days: HolidayDay[]
  outside: number
} {
  const days: HolidayDay[] = []
  let outside = 0
  for (const e of events) {
    const name = e.summary.slice(0, NAME_MAX)
    for (let d = e.start; d && d <= e.end; d = addDays(d, 1)) {
      if (e.yearly) days.push({ date: intoRange(d), name, yearly: true })
      else if (yearInRange(yearOf(d)))
        days.push({ date: d, name, yearly: false })
      else outside++
    }
  }
  return { days, outside }
}

/** "3 days outside 1970–2099 skipped", for an import's summary. */
export function outsideSkipped(n: number): string {
  return n ? `${plural(n, "day")} outside ${YEARS} skipped` : ""
}

// ─── showing ────────────────────────────────────────────────────────────────

/** "11 days in 2026 · 2 agreements" - the year's holidays, yearly included. */
export function calendarSummary(
  days: HolidayDay[],
  agreements: number,
  year: number
): string {
  const n = daysInYear(days, year).length
  const count = n ? `${plural(n, "day")} in ${year}` : `No days in ${year}`
  return `${count} · ${plural(agreements, "agreement")}`
}

/** "Fri 25 Dec", or "Fri Dec 25" for a month-first date format. */
export function dayLabel(iso: string, format?: DateFormat): string {
  const wd = WEEKDAY[utcDay(iso)]
  const mon = MONTHS[Number(iso.slice(5, 7)) - 1].slice(0, 3)
  const day = Number(iso.slice(8, 10))
  return format === "MM/DD/YYYY" ? `${wd} ${mon} ${day}` : `${wd} ${day} ${mon}`
}

/** "Friday 25 December 2026" - for screen readers. */
export function dayLabelLong(iso: string): string {
  const mon = MONTHS[Number(iso.slice(5, 7)) - 1]
  return `${WEEKDAY_LONG[utcDay(iso)]} ${Number(iso.slice(8, 10))} ${mon} ${iso.slice(0, 4)}`
}

/** "25 December" - a day's name in a control's label. */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
}

export function isWeekend(iso: string): boolean {
  const d = utcDay(iso)
  return d === 0 || d === 6
}

/** The same month and day in `year`; 29 February becomes the 28th. */
export function sameDayIn(iso: string, year: number): string {
  const moved = `${pad(year, 4)}-${monthDay(iso)}`
  return isIsoDate(moved) ? moved : `${pad(year, 4)}-02-28`
}

/** A month on, or back, keeping the day where the month has it. */
function plusMonths(iso: string, months: number): string {
  const y = yearOf(iso)
  const m = Number(iso.slice(5, 7)) - 1 + months
  const ny = y + Math.floor(m / 12)
  const nm = ((m % 12) + 12) % 12
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate()
  const d = Math.min(Number(iso.slice(8, 10)), last)
  return `${pad(ny, 4)}-${pad(nm + 1)}-${pad(d)}`
}

/** Where a key moves the focus in a year of days: arrows by a day or a week,
 * Home/End to the week's Monday or Sunday, Page Up/Down by a month, and with
 * Shift by a year. `null` for any other key. */
export function stepDay(
  iso: string,
  key: string,
  shift = false
): string | null {
  const monday = (utcDay(iso) + 6) % 7
  switch (key) {
    case "ArrowLeft":
      return addDays(iso, -1)
    case "ArrowRight":
      return addDays(iso, 1)
    case "ArrowUp":
      return addDays(iso, -7)
    case "ArrowDown":
      return addDays(iso, 7)
    case "Home":
      return addDays(iso, -monday)
    case "End":
      return addDays(iso, 6 - monday)
    case "PageUp":
      return plusMonths(iso, shift ? -12 : -1)
    case "PageDown":
      return plusMonths(iso, shift ? 12 : 1)
    default:
      return null
  }
}
