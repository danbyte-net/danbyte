// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { Device, DeviceCoverageBrief } from "@/lib/api"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import {
  ContractStateBadge,
  CoverageBadge,
  coverageColumn,
} from "./coverage-cell"

// Support coverage (#421): the status reads as a pill, the device column is
// on by default and its facet buckets rows without coverage as "none".

afterEach(cleanup)

type Row = { coverage?: DeviceCoverageBrief }

describe("coverage cell", () => {
  it("renders each status as its pill", () => {
    render(
      <>
        <CoverageBadge status="covered" />
        <CoverageBadge status="expiring" />
        <CoverageBadge status="expired" />
        <CoverageBadge status="none" />
      </>
    )
    for (const label of ["Covered", "Expiring", "Expired", "Not covered"])
      expect(screen.getByText(label)).toBeTruthy()
  })

  it("colours by meaning, not by name", () => {
    render(
      <>
        <CoverageBadge status="expired" />
        <ContractStateBadge state="active" />
      </>
    )
    expect(screen.getByText("Expired").getAttribute("data-variant")).toBe(
      "destructive"
    )
    expect(screen.getByText("Active").getAttribute("data-variant")).toBe(
      "success"
    )
  })

  it("buckets rows by status, a row without coverage as none", () => {
    const col = coverageColumn<Row>({ get: (r) => r.coverage })
    const meta = col.meta as {
      facet: { get: (r: Row) => string }
      export: { value: (r: Row) => string }
    }
    const row: Row = {
      coverage: { status: "expiring", end: "2026-12-01", contracts: 1 },
    }
    expect(meta.facet.get(row)).toBe("expiring")
    expect(meta.facet.get({})).toBe("none")
    expect(meta.export.value({})).toBe("Not covered")
  })

  it("is a device column by default", () => {
    const ids = buildDeviceColumns<Device>().map((c) => c.id)
    expect(ids).toContain("coverage")
    expect(
      buildDeviceColumns<Device>({ omit: ["coverage"] }).map((c) => c.id)
    ).not.toContain("coverage")
  })
})
