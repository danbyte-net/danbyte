import { describe, expect, it } from "vitest"

import { readAllDayEvents } from "./ics"

const cal = (...events: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.map((e) => `BEGIN:VEVENT\n${e}\nEND:VEVENT`),
    "END:VCALENDAR",
  ].join("\n")

describe("readAllDayEvents", () => {
  it("reads DATE values, with or without VALUE=DATE, and CRLF lines", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20261225\nDTEND;VALUE=DATE:20261226\nSUMMARY:Christmas Day",
      "DTSTART:20261226\nSUMMARY:Boxing Day"
    ).replace(/\n/g, "\r\n")
    expect(readAllDayEvents(text).events).toEqual([
      {
        start: "2026-12-25",
        end: "2026-12-25",
        summary: "Christmas Day",
        yearly: false,
      },
      {
        start: "2026-12-26",
        end: "2026-12-26",
        summary: "Boxing Day",
        yearly: false,
      },
    ])
  })

  it("unfolds long lines and unescapes text", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20260501\nSUMMARY:Labour\\, May\n  Day\\; bank\\\\holiday\\nobserved"
    )
    expect(readAllDayEvents(text).events[0].summary).toBe(
      "Labour, May Day; bank\\holiday observed"
    )
  })

  it("treats DTEND as exclusive and reads DURATION", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20260720\nDTEND;VALUE=DATE:20260803\nSUMMARY:Summer closure",
      "DTSTART;VALUE=DATE:20261224\nDURATION:P3D\nSUMMARY:Christmas",
      "DTSTART;VALUE=DATE:20260101\nDURATION:P1W\nSUMMARY:Week"
    )
    const [summer, xmas, week] = readAllDayEvents(text).events
    expect([summer.start, summer.end]).toEqual(["2026-07-20", "2026-08-02"])
    expect([xmas.start, xmas.end]).toEqual(["2026-12-24", "2026-12-26"])
    expect([week.start, week.end]).toEqual(["2026-01-01", "2026-01-07"])
  })

  it("follows only a plain yearly repeat on the start's own date", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20201225\nRRULE:FREQ=YEARLY\nSUMMARY:Christmas",
      "DTSTART;VALUE=DATE:20201225\nRRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=25\nSUMMARY:Same",
      "DTSTART;VALUE=DATE:20101125\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH\nSUMMARY:Thanksgiving",
      "DTSTART;VALUE=DATE:20260101\nRRULE:FREQ=MONTHLY\nSUMMARY:Monthly",
      "DTSTART;VALUE=DATE:20260101\nRRULE:FREQ=YEARLY;INTERVAL=2\nSUMMARY:Every other"
    )
    const read = readAllDayEvents(text)
    expect(read.events.map((e) => [e.summary, e.yearly])).toEqual([
      ["Christmas", true],
      ["Same", true],
    ])
    expect(read.repeating).toBe(3)
  })

  it("expands a yearly repeat that ends into its years", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20260601\nRRULE:FREQ=YEARLY;COUNT=3\nSUMMARY:Count",
      "DTSTART;VALUE=DATE:20260701\nRRULE:FREQ=YEARLY;UNTIL=20280701T000000Z\nSUMMARY:Until"
    )
    const events = readAllDayEvents(text).events
    expect(events.map((e) => [e.start, e.yearly])).toEqual([
      ["2026-06-01", false],
      ["2027-06-01", false],
      ["2028-06-01", false],
      ["2026-07-01", false],
      ["2027-07-01", false],
      ["2028-07-01", false],
    ])
  })

  it("skips timed, cancelled and changed-occurrence events", () => {
    const text = cal(
      "DTSTART:20261225T090000Z\nDTEND:20261225T100000Z\nSUMMARY:Meeting",
      "DTSTART;TZID=Europe/Copenhagen:20261224T120000\nSUMMARY:Lunch",
      "DTSTART;VALUE=DATE:20261231\nSTATUS:CANCELLED\nSUMMARY:Cancelled",
      "DTSTART;VALUE=DATE:20270101\nRECURRENCE-ID;VALUE=DATE:20270101\nSUMMARY:Moved",
      "DTSTART;VALUE=DATE:20261226\nSUMMARY:Kept\nBEGIN:VALARM\nTRIGGER:-PT15M\nDESCRIPTION:Not the summary\nEND:VALARM"
    )
    const read = readAllDayEvents(text)
    expect(read.events.map((e) => e.summary)).toEqual(["Kept"])
    expect(read.timed).toBe(2)
  })

  it("takes Outlook's midnight-to-midnight all-day events as days", () => {
    const text = cal(
      "DTSTART;TZID=W. Europe Standard Time:20261225T000000\nDTEND;TZID=W. Europe Standard Time:20261227T000000\nX-MICROSOFT-CDO-ALLDAYEVENT:TRUE\nSUMMARY:Christmas"
    )
    const [e] = readAllDayEvents(text).events
    expect([e.start, e.end]).toEqual(["2026-12-25", "2026-12-26"])
  })

  it("keeps a quoted colon in a parameter out of the value", () => {
    const text = cal(
      'DTSTART;X-NOTE="a:b";VALUE=DATE:20260105\nSUMMARY;LANGUAGE=da:Helligtrekonger'
    )
    expect(readAllDayEvents(text).events[0]).toMatchObject({
      start: "2026-01-05",
      summary: "Helligtrekonger",
    })
  })

  it("counts events it cannot place", () => {
    const text = cal(
      "DTSTART;VALUE=DATE:20260230\nSUMMARY:No such day",
      "DTSTART;VALUE=DATE:20260101\nDTEND;VALUE=DATE:20280101\nSUMMARY:Two years"
    )
    const read = readAllDayEvents(text)
    expect(read.events).toEqual([])
    expect(read.other).toBe(2)
  })
})
