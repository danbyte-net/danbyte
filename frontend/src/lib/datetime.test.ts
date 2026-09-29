import { describe, expect, it } from "vitest"

import { addDays, formatCustom, isIsoDate } from "./datetime"
import type { DateTimeSettings } from "./api"

const at = "2026-09-24T17:00:00Z"
const s = (time_style: "24h" | "12h"): DateTimeSettings => ({
  date_format: "YYYY-MM-DD",
  time_style,
  timezone: "UTC",
})

describe("formatCustom follows the clock setting", () => {
  it("shows 24-hour hours with minutes", () => {
    expect(formatCustom(at, { hour: "2-digit" }, s("24h"))).toBe("17:00")
    expect(
      formatCustom(at, { weekday: "short", hour: "2-digit" }, s("24h"))
    ).toBe("Thu 17:00")
  })

  it("shows 12-hour hours with AM/PM", () => {
    expect(formatCustom(at, { hour: "2-digit" }, s("12h"))).toBe("05 PM")
  })

  it("keeps a clock the caller pinned, and leaves dates alone", () => {
    expect(formatCustom(at, { hour: "2-digit", hour12: true }, s("24h"))).toBe(
      "05 PM"
    )
    expect(formatCustom(at, { month: "short", day: "numeric" }, s("24h"))).toBe(
      "Sep 24"
    )
  })
})

describe("bare dates", () => {
  it("knows a real calendar date", () => {
    expect(isIsoDate("2028-02-29")).toBe(true)
    expect(isIsoDate("2026-02-29")).toBe(false)
    expect(isIsoDate("2026-02-30")).toBe(false)
    expect(isIsoDate("20261225")).toBe(false)
  })

  it("moves by days across months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01")
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28")
    expect(addDays("2026-02-30", 1)).toBe("")
  })
})
