// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import type { PrtgDefaults, PrtgDeviceState } from "@/lib/api"
import { editableOnly } from "@/components/prtg/state-map"
import { prtgColumn } from "./prtg-columns"

// The device list's PRTG column: the roll-up is the state's own pill (never a
// dot), down and warning sensors are counted beside it, and the row links to
// the device in PRTG.

afterEach(cleanup)

const STATES: Record<string, PrtgDeviceState> = {
  d1: {
    state: "degraded",
    down: 2,
    warning: 1,
    name: "db-dev01",
    url: "https://prtg.example.com/device.htm?id=2081",
  },
  d2: { state: "up", down: 0, warning: 0, name: "db-zabbix", url: "u" },
}

function cell(id: string) {
  const col = prtgColumn<{ id: string }>(STATES)
  const ctx = { row: { original: { id } } } as unknown as CellContext<
    { id: string },
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

describe("prtgColumn", () => {
  it("renders the state pill, the counts and the PRTG link", () => {
    const el = cell("d1")
    expect(el.textContent).toContain("2")
    expect(el.textContent).toContain("1")
    expect(el.textContent).toContain("down")
    const link = el.querySelector("a")
    expect(link?.getAttribute("href")).toBe(
      "https://prtg.example.com/device.htm?id=2081"
    )
    expect(link?.getAttribute("target")).toBe("_blank")
  })

  it("shows no counts when nothing is down or warning", () => {
    expect(cell("d2").querySelectorAll(".num")).toHaveLength(0)
  })

  it("is a dash for an unlinked device", () => {
    expect(cell("nope").querySelector("a")).toBeNull()
  })

  it("is hidden until ticked and sorts worst first", () => {
    const col = prtgColumn<{ id: string }>(STATES)
    expect(col.meta?.defaultHidden).toBe(true)
    const get = (
      col as unknown as { accessorFn: (r: { id: string }) => number }
    ).accessorFn
    expect(get({ id: "d1" })).toBeGreaterThan(get({ id: "d2" }))
  })
})

describe("editableOnly", () => {
  const defaults: PrtgDefaults = {
    codes: [
      { value: "3", label: "Up", fixed: false, reason: "" },
      { value: "11", label: "Not Licensed", fixed: true, reason: "x" },
    ],
    default_map: { "3": "up", "11": "unknown" },
    statuses: [],
  }

  it("sends only the codes an operator may place", () => {
    expect(
      editableOnly({ "3": "degraded", "11": "unknown" }, defaults)
    ).toEqual({ "3": "degraded" })
    expect(editableOnly({ "3": "down" })).toEqual({})
  })
})
