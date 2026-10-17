import { describe, expect, it } from "vitest"

import type { SlaReportSchedule } from "@/lib/api"
import { ticketLabel } from "./sla-columns"
import { scheduleWhen } from "./sla-schedule-columns"

describe("ticketLabel", () => {
  it("shows the ticket's last path part", () => {
    expect(ticketLabel("https://tickets.example.com/browse/INC-4411")).toBe(
      "INC-4411"
    )
  })
  it("falls back to the host, then the text", () => {
    expect(ticketLabel("https://tickets.example.com/")).toBe(
      "tickets.example.com"
    )
    expect(ticketLabel("not a url")).toBe("not a url")
  })
})

describe("scheduleWhen", () => {
  const base = {
    weekday: 0,
    day_of_month: 1,
    hour: 7,
  } as SlaReportSchedule
  it("reads a weekly schedule", () => {
    expect(scheduleWhen({ ...base, frequency: "weekly", weekday: 4 })).toBe(
      "Fridays 07:00"
    )
  })
  it("reads a monthly schedule", () => {
    expect(
      scheduleWhen({ ...base, frequency: "monthly", day_of_month: 3, hour: 18 })
    ).toBe("Day 3, 18:00")
  })
})
