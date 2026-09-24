import { describe, expect, it } from "vitest"

import { formatCustom } from "./datetime"
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
