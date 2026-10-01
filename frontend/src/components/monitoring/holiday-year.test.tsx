// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { HolidayDay } from "@/lib/api"
import { toggleDay } from "./holiday-days"
import { HolidayYear } from "./holiday-year"

afterEach(cleanup)

function Harness({ initial }: { initial: HolidayDay[] }) {
  const [days, setDays] = useState(initial)
  const [year, setYear] = useState(2026)
  const [focusIso, setFocusIso] = useState("2026-12-24")
  const [onFocusDay] = useState(() => (iso: string) => {
    setFocusIso(iso)
    setYear(Number(iso.slice(0, 4)))
  })
  const [onToggle] = useState(
    () => (iso: string) => setDays((d) => toggleDay(d, iso))
  )
  return (
    <HolidayYear
      year={year}
      days={days}
      today="2026-09-29"
      focusIso={focusIso}
      onFocusDay={onFocusDay}
      onToggle={onToggle}
    />
  )
}

const day = (label: RegExp) => screen.getByRole("button", { name: label })

describe("HolidayYear", () => {
  it("draws every day of the year as a toggle", () => {
    const { container } = render(<Harness initial={[]} />)
    expect(container.querySelectorAll("button[data-day]")).toHaveLength(365)
    expect(screen.getAllByRole("group")).toHaveLength(12)
  })

  it("marks a yearly day in any year", () => {
    render(
      <Harness
        initial={[{ date: "2020-12-25", name: "Christmas Day", yearly: true }]}
      />
    )
    const xmas = day(/^Friday 25 December 2026, Christmas Day, every year$/)
    expect(xmas.getAttribute("aria-pressed")).toBe("true")
    expect(
      day(/^Thursday 24 December 2026$/).getAttribute("aria-pressed")
    ).toBe("false")
  })

  it("toggles on click and keeps the same button, so focus stays", () => {
    const { container } = render(<Harness initial={[]} />)
    // By its date: a name query walks all 365 days' names, which overran the
    // time limit on a busy machine.
    const cell = () =>
      container.querySelector<HTMLElement>('button[data-day="2026-12-24"]')!
    const before = cell()
    before.focus()
    fireEvent.click(before)
    const after = cell()
    expect(after).toBe(before)
    expect(after.getAttribute("aria-pressed")).toBe("true")
    expect(document.activeElement).toBe(after)
  })

  it("moves the one tab stop with the arrow keys, into the next year", () => {
    const { container } = render(<Harness initial={[]} />)
    const stops = () =>
      [...container.querySelectorAll<HTMLElement>("button[data-day]")].filter(
        (b) => b.tabIndex === 0
      )
    expect(stops().map((b) => b.dataset.day)).toEqual(["2026-12-24"])
    fireEvent.keyDown(stops()[0], { key: "ArrowRight" })
    expect(stops().map((b) => b.dataset.day)).toEqual(["2026-12-25"])
    expect(document.activeElement).toBe(stops()[0])
    fireEvent.keyDown(stops()[0], { key: "ArrowDown" })
    expect(stops().map((b) => b.dataset.day)).toEqual(["2027-01-01"])
    expect(document.activeElement?.getAttribute("data-day")).toBe("2027-01-01")
  })
})
