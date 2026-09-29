import { describe, expect, it } from "vitest"

import type { HolidayDay } from "@/lib/api"
import {
  calendarSummary,
  dayLabel,
  dayLabelLong,
  daysFromIcs,
  daysInYear,
  holidayOn,
  isWeekend,
  mergeDays,
  normaliseDays,
  parsePasted,
  sameDayIn,
  setYearly,
  stepDay,
  toggleDay,
} from "./holiday-days"

const once = (date: string, name = ""): HolidayDay => ({
  date,
  name,
  yearly: false,
})
const every = (date: string, name = ""): HolidayDay => ({
  date,
  name,
  yearly: true,
})

describe("normaliseDays", () => {
  it("applies the server's rules", () => {
    expect(
      normaliseDays([
        once("2026-12-26"),
        once("2026-12-26", "Boxing Day"),
        once("2027-01-01", "New Year"),
        every("2020-01-01"),
        once("2026-12-24", "Christmas Eve"),
      ])
    ).toEqual([
      every("2020-01-01", "New Year"),
      once("2026-12-24", "Christmas Eve"),
      once("2026-12-26", "Boxing Day"),
    ])
  })
})

describe("toggleDay", () => {
  it("adds a one-off day, and takes it off again", () => {
    const added = toggleDay([], "2026-12-25")
    expect(added).toEqual([once("2026-12-25")])
    expect(toggleDay(added, "2026-12-25")).toEqual([])
  })

  it("takes a yearly day off in every year from any year", () => {
    const days = [every("2020-12-25", "Christmas Day"), once("2026-12-24")]
    expect(holidayOn(days, "2031-12-25")?.name).toBe("Christmas Day")
    expect(toggleDay(days, "2031-12-25")).toEqual([once("2026-12-24")])
  })
})

describe("setYearly", () => {
  it("on folds one-off days on the same month and day into it", () => {
    const days = [once("2026-12-25"), once("2027-12-25", "Christmas Day")]
    expect(setYearly(days, "2026-12-25", true, "2026-12-25")).toEqual([
      every("2026-12-25", "Christmas Day"),
    ])
  })

  it("off keeps the day in view as a one-off", () => {
    const days = [every("2020-12-25", "Christmas Day")]
    expect(setYearly(days, "y-12-25", false, "2027-12-25")).toEqual([
      once("2027-12-25", "Christmas Day"),
    ])
  })
})

describe("daysInYear", () => {
  it("includes yearly days, and a yearly 29 February in leap years only", () => {
    const days = [every("2024-02-29", "Leap"), once("2027-03-01")]
    expect(daysInYear(days, 2028).map((d) => d.iso)).toEqual(["2028-02-29"])
    expect(daysInYear(days, 2027).map((d) => d.iso)).toEqual(["2027-03-01"])
  })
})

describe("mergeDays", () => {
  it("keeps days already there and counts what is new", () => {
    const days = [once("2026-12-25", "Christmas Day"), once("2026-12-26")]
    const out = mergeDays(days, [
      once("2026-12-25", "Xmas"),
      once("2026-12-26", "Boxing Day"),
      once("2027-01-01", "New Year"),
      once("2028-01-01"),
      every("2026-05-01", "May Day"),
    ])
    expect(out.added).toBe(3)
    expect(out.named).toBe(1)
    expect(out.yearly).toBe(1)
    expect(out.years).toEqual([2027, 2028])
    expect(holidayOn(out.days, "2026-12-25")?.name).toBe("Christmas Day")
    expect(holidayOn(out.days, "2026-12-26")?.name).toBe("Boxing Day")
  })
})

describe("parsePasted", () => {
  it("reads lines, commas and names on either side of a date", () => {
    const { days, errors } = parsePasted(
      [
        "2026-12-24 Christmas Eve",
        "Christmas Day: 2026-12-25",
        "2026-12-31, 2027-01-01",
        "",
        "2027-04-02 - Good Friday",
      ].join("\n")
    )
    expect(errors).toEqual([])
    expect(days).toEqual([
      once("2026-12-24", "Christmas Eve"),
      once("2026-12-25", "Christmas Day"),
      once("2026-12-31"),
      once("2027-01-01"),
      once("2027-04-02", "Good Friday"),
    ])
  })

  it("names each of several dates by the text after it", () => {
    const { days } = parsePasted(
      "2026-12-24 Christmas Eve, 2026-12-25 Christmas Day"
    )
    expect(days.map((d) => d.name)).toEqual(["Christmas Eve", "Christmas Day"])
  })

  it("reports bad dates and lines without one by line", () => {
    const { days, errors } = parsePasted("2026-12-24\nholiday\n2026-02-30 Nope")
    expect(days).toEqual([once("2026-12-24")])
    expect(errors).toEqual([
      "Line 2: no date.",
      "Line 3: «2026-02-30» is not a date.",
    ])
  })

  it("also reads the user's own date format", () => {
    expect(parsePasted("24.12.2026 Juleaften", "DD.MM.YYYY").days).toEqual([
      once("2026-12-24", "Juleaften"),
    ])
    expect(parsePasted("12/24/2026", "MM/DD/YYYY").days).toEqual([
      once("2026-12-24"),
    ])
    expect(parsePasted("24 Dec 2026", "DD MMM YYYY").days).toEqual([
      once("2026-12-24"),
    ])
  })
})

describe("daysFromIcs", () => {
  it("adds every day of an event", () => {
    expect(
      daysFromIcs([
        {
          start: "2026-12-30",
          end: "2027-01-02",
          summary: "Closed",
          yearly: false,
        },
      ]).map((d) => d.date)
    ).toEqual(["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"])
  })
})

describe("labels", () => {
  it("summarises the year, yearly days included", () => {
    const days = [every("2020-12-25"), once("2026-12-24"), once("2027-01-01")]
    expect(calendarSummary(days, 2, 2026)).toBe("2 days in 2026 · 2 agreements")
    expect(calendarSummary([once("2026-12-24")], 1, 2026)).toBe(
      "1 day in 2026 · 1 agreement"
    )
    expect(calendarSummary([], 0, 2026)).toBe("No days in 2026 · 0 agreements")
  })

  it("names days in UTC, in the user's order", () => {
    // 2026-12-25 is a Friday wherever the test runs.
    expect(dayLabel("2026-12-25")).toBe("Fri 25 Dec")
    expect(dayLabel("2026-12-25", "MM/DD/YYYY")).toBe("Fri Dec 25")
    expect(dayLabelLong("2026-12-25")).toBe("Friday 25 December 2026")
    expect(isWeekend("2026-12-26")).toBe(true)
    expect(isWeekend("2026-12-25")).toBe(false)
  })
})

describe("stepDay", () => {
  it("moves by days, weeks, months and years", () => {
    expect(stepDay("2026-12-31", "ArrowRight")).toBe("2027-01-01")
    expect(stepDay("2026-01-01", "ArrowLeft")).toBe("2025-12-31")
    expect(stepDay("2026-12-29", "ArrowDown")).toBe("2027-01-05")
    // 2026-12-25 is a Friday: its week runs Monday 21 to Sunday 27.
    expect(stepDay("2026-12-25", "Home")).toBe("2026-12-21")
    expect(stepDay("2026-12-25", "End")).toBe("2026-12-27")
    expect(stepDay("2026-01-31", "PageDown")).toBe("2026-02-28")
    expect(stepDay("2026-01-15", "PageUp")).toBe("2025-12-15")
    expect(stepDay("2028-02-29", "PageDown", true)).toBe("2029-02-28")
    expect(stepDay("2026-01-01", "Tab")).toBeNull()
  })

  it("keeps the same day when the year changes", () => {
    expect(sameDayIn("2026-12-25", 2030)).toBe("2030-12-25")
    expect(sameDayIn("2028-02-29", 2029)).toBe("2029-02-28")
  })
})
