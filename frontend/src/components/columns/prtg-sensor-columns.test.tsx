// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext, ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import type { PrtgSensor } from "@/lib/api"
import { sensor } from "@/components/prtg/prtg-test-utils"
import {
  buildPrtgSensorColumns,
  sensorBucket,
  sensorSince,
} from "./prtg-sensor-columns"

// One factory for the /prtg Alarms and Sensors tables: the state is the
// state's own pill (never a dot), the four facets are declared on the
// columns, and the last value and uptime belong to the Sensors variant only.

afterEach(cleanup)

type Col = ColumnDef<PrtgSensor, unknown> & {
  accessorFn?: (r: PrtgSensor) => unknown
  meta?: { facet?: { get: (r: PrtgSensor) => string } }
}

function col(id: string, variant: "alarms" | "sensors" = "sensors") {
  return buildPrtgSensorColumns({ variant }).find((c) => c.id === id) as Col
}

function cell(id: string, row: PrtgSensor) {
  const ctx = { row: { original: row } } as unknown as CellContext<
    PrtgSensor,
    unknown
  >
  return render(<div>{flexRender(col(id).cell, ctx)}</div>).container
}

describe("buildPrtgSensorColumns", () => {
  it("has value and uptime only in the Sensors variant", () => {
    const ids = (v: "alarms" | "sensors") =>
      buildPrtgSensorColumns({ variant: v }).map((c) => c.id)
    expect(ids("alarms")).not.toContain("value")
    expect(ids("alarms")).not.toContain("uptime")
    expect(ids("sensors")).toEqual(expect.arrayContaining(["value", "uptime"]))
  })

  it("declares the four facets", () => {
    const faceted = buildPrtgSensorColumns({ variant: "alarms" })
      .filter((c) => (c as Col).meta?.facet)
      .map((c) => c.id)
    expect(faceted).toEqual(["device", "kind", "state", "probe"])
  })

  it("renders the state as a pill, not a dot", () => {
    const el = cell("state", sensor("1", { state: "down", status: "Down" }))
    expect(el.textContent).toContain("Down")
    expect(el.querySelector(".rounded-full")).toBeNull()
  })

  it("sorts worst first and buckets paused apart", () => {
    const rank = col("state").accessorFn! as (r: unknown, i?: number) => number
    expect(rank(sensor("1", { state: "down" }))).toBeGreaterThan(
      rank(sensor("2", { state: "degraded" }))
    )
    const paused = sensor("3", { paused: true, state: "unknown" })
    expect(sensorBucket(paused)).toBe("paused")
    expect(rank(paused)).toBe(0)
  })

  it("dates since the last down, else the last check", () => {
    expect(
      sensorSince(sensor("1", { last_down_at: "2026-10-26T07:00:00Z" }))
    ).toBe("2026-10-26T07:00:00Z")
    expect(sensorSince(sensor("1"))).toBe("2026-10-26T08:00:00Z")
  })

  it("marks acknowledged sensors and links to PRTG", () => {
    expect(
      cell("acknowledged", sensor("1", { acknowledged: true })).textContent
    ).toBe("Acknowledged")
    const a = cell("prtg", sensor("2091")).querySelector("a")
    expect(a?.getAttribute("href")).toBe(
      "https://prtg.example.com/sensor.htm?id=2091"
    )
    expect(a?.getAttribute("aria-label")).toBe("Open Sensor 2091 in PRTG")
  })

  it("groups probe and group without repeating one name", () => {
    const get = col("probe").meta!.facet!.get
    expect(get(sensor("1"))).toBe("Local Probe / Lab")
    expect(get(sensor("1", { group_path: "Local Probe" }))).toBe("Local Probe")
  })
})
