// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { buildDeviceColumns } from "@/components/columns/device-columns"
import { buildVmColumns } from "@/components/columns/vm-columns"
import {
  SoftwareVersionText,
  softwareTargetColumn,
  softwareTargetState,
  softwareVersionLabel,
} from "./software-version-cell"

// Software target (#395): the version text, the on/off/unknown rule and the
// hidden-by-default columns on the device and VM lists.

afterEach(cleanup)

type Row = { version: string; target: string }

describe("software version text", () => {
  it("shows the version and the target", () => {
    expect(softwareVersionLabel("17.9.4a", "17.9.5")).toBe(
      "17.9.4a · target 17.9.5"
    )
    expect(softwareVersionLabel("17.9.4a", "")).toBe("17.9.4a")
    expect(softwareVersionLabel("", "17.9.5")).toBe("target 17.9.5")
    expect(softwareVersionLabel("", null)).toBe("")
  })

  it("renders nothing when neither is set", () => {
    const { container } = render(<SoftwareVersionText version="" />)
    expect(container.textContent).toBe("")
    render(<SoftwareVersionText version="8.0.3" target="8.0.3" />)
    expect(screen.getByText("8.0.3 · target 8.0.3")).toBeTruthy()
  })
})

describe("software target state", () => {
  it("matches the API filter", () => {
    expect(softwareTargetState("17.9.5", "17.9.5")).toBe("on")
    expect(softwareTargetState("17.9.4a", "17.9.5")).toBe("off")
    expect(softwareTargetState("", "17.9.5")).toBe("unknown")
    expect(softwareTargetState("17.9.4a", "")).toBe("unknown")
  })

  it("buckets rows in the facet", () => {
    const col = softwareTargetColumn<Row>({
      target: (r) => r.target,
      version: (r) => r.version,
    })
    const facet = (col.meta as { facet: { get: (r: Row) => string } }).facet
    expect(facet.get({ version: "1", target: "2" })).toBe("off")
    expect(facet.get({ version: "2", target: "2" })).toBe("on")
  })
})

describe("list columns", () => {
  it("are on the device and VM lists, hidden by default", () => {
    for (const cols of [buildDeviceColumns(), buildVmColumns()]) {
      for (const id of ["software_version", "software_target"]) {
        const col = cols.find((c) => c.id === id)
        expect(col).toBeTruthy()
        expect((col?.meta as { defaultHidden?: boolean }).defaultHidden).toBe(
          true
        )
      }
    }
  })
})
