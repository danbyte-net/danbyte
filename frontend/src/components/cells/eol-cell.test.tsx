// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import type { Device, VirtualMachine } from "@/lib/api"
import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { EolBadge, eolColumn } from "./eol-cell"

// End-of-life data (#8): the column exists only while the feature is on, and
// its facet buckets on the platform's status.

afterEach(cleanup)

type Row = { platform: { eol: { status: "eol" | "ending" } | null } | null }

describe("end-of-life cell", () => {
  it("renders each status as its badge", () => {
    render(
      <>
        <EolBadge info={{ status: "eol" }} />
        <EolBadge info={{ status: "ending" }} />
        <EolBadge info={{ status: "supported" }} />
        <EolBadge info={{ status: "unknown" }} />
      </>
    )
    for (const label of [
      "End of life",
      "Support ending",
      "Supported",
      "Unknown",
    ])
      expect(screen.getByText(label)).toBeTruthy()
  })

  it("buckets rows by status, unmapped as unknown", () => {
    const col = eolColumn<Row>({ get: (r) => r.platform?.eol })
    const facet = (col.meta as { facet: { get: (r: Row) => string } }).facet
    expect(facet.get({ platform: { eol: { status: "eol" } } })).toBe("eol")
    expect(facet.get({ platform: null })).toBe("unknown")
  })

  it("is only offered while the feature is on", () => {
    const ids = (cols: { id?: string }[]) => cols.map((c) => c.id)
    expect(ids(buildDeviceColumns<Device>())).not.toContain("eol")
    expect(ids(buildDeviceColumns<Device>({ eol: true }))).toContain("eol")
    expect(ids(buildVmColumns<VirtualMachine>())).not.toContain("eol")
    expect(ids(buildVmColumns<VirtualMachine>({ eol: true }))).toContain("eol")
  })
})
