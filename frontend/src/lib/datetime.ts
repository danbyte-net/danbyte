import { useMemo } from "react"

import type { DateFormat, DateTimeSettings, TimeStyle } from "@/lib/api"
import { useMe } from "@/lib/use-me"

// Date/time formatting per the user's EFFECTIVE display settings (user pref →
// tenant default → deployment default), resolved server-side and read from
// /api/me/ (`me.datetime`). Formats via Intl — no date library.
//
// Components should reach for the `useDateFormat()` hook; the plain functions
// take an explicit settings object for non-hook call sites.

/** Fallback while /api/me/ is loading (or for anonymous pages): ISO + 24h in
 * the browser's own timezone. */
export function defaultDateTimeSettings(): DateTimeSettings {
  return {
    date_format: "YYYY-MM-DD",
    time_style: "24h",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  }
}

// A bare calendar date ("2026-01-31" — lifecycle dates, DRF DateFields). These
// have no instant, so they must NOT be timezone-shifted: 2026-01-31 stays
// 31 Jan regardless of the viewer's timezone.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

type DateInput = string | number | Date | null | undefined

function toDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null
  const d =
    typeof value === "string" && DATE_ONLY_RE.test(value)
      ? new Date(`${value}T00:00:00Z`) // fixed instant, rendered in UTC below
      : new Date(value)
  return isNaN(d.getTime()) ? null : d
}

function zoneFor(value: DateInput, timezone: string): string {
  // Date-only values render in UTC so the calendar day never shifts.
  return typeof value === "string" && DATE_ONLY_RE.test(value)
    ? "UTC"
    : timezone
}

function dateParts(d: Date, timeZone: string) {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  } catch {
    // Unknown zone from an older backend/browser — fall back to local.
    fmt = new Intl.DateTimeFormat("en-GB", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
  }
  const p: Record<string, string> = {}
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value
  return { y: p.year, m: p.month, d: p.day }
}

function monthShort(d: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      month: "short",
    }).format(d)
  } catch {
    return new Intl.DateTimeFormat("en-GB", { month: "short" }).format(d)
  }
}

function assembleDate(d: Date, pattern: DateFormat, timeZone: string): string {
  const { y, m, d: dd } = dateParts(d, timeZone)
  switch (pattern) {
    case "DD.MM.YYYY":
      return `${dd}.${m}.${y}`
    case "DD/MM/YYYY":
      return `${dd}/${m}/${y}`
    case "MM/DD/YYYY":
      return `${m}/${dd}/${y}`
    case "DD MMM YYYY":
      return `${dd} ${monthShort(d, timeZone)} ${y}`
    case "YYYY-MM-DD":
    default:
      return `${y}-${m}-${dd}`
  }
}

function assembleTime(d: Date, style: TimeStyle, timeZone: string): string {
  const opts: Intl.DateTimeFormatOptions =
    style === "12h"
      ? { hour: "numeric", minute: "2-digit", hour12: true }
      : { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(d)
  } catch {
    return new Intl.DateTimeFormat("en-US", opts).format(d)
  }
}

/** "31.01.2026" — per the effective date format + timezone. */
export function formatDate(value: DateInput, s: DateTimeSettings): string {
  const d = toDate(value)
  if (!d) return ""
  return assembleDate(d, s.date_format, zoneFor(value, s.timezone))
}

/** "14:30" or "2:30 PM" — per the effective clock + timezone. */
export function formatTime(value: DateInput, s: DateTimeSettings): string {
  const d = toDate(value)
  if (!d) return ""
  return assembleTime(d, s.time_style, zoneFor(value, s.timezone))
}

/** "31.01.2026 14:30" — date + time in one string. */
export function formatDateTime(value: DateInput, s: DateTimeSettings): string {
  const d = toDate(value)
  if (!d) return ""
  const tz = zoneFor(value, s.timezone)
  return `${assembleDate(d, s.date_format, tz)} ${assembleTime(d, s.time_style, tz)}`
}

/** The effective settings + bound formatters. Reads `me.datetime` (already
 * resolved user → tenant → deployment on the server). */
export function useDateFormat() {
  const { me } = useMe()
  const settings = me.datetime
  return useMemo(() => {
    const s = settings ?? defaultDateTimeSettings()
    return {
      settings: s,
      formatDate: (v: DateInput) => formatDate(v, s),
      formatTime: (v: DateInput) => formatTime(v, s),
      formatDateTime: (v: DateInput) => formatDateTime(v, s),
    }
  }, [settings])
}
