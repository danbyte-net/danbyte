// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Rack } from "@/lib/api"
import { buildRackColumns } from "./rack-columns"
import type { RackColumnId } from "./rack-columns"

// A rack's space and power read on the racks' one capacity scale
// (lib/rack-capacity.ts): above 80 % amber, above 95 % red.

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/planning/planned-change-badge", () => ({
  PlannedChangeMarker: () => null,
}))

function rack(patch: Partial<Rack> = {}): Rack {
  return {
    id: "r1",
    numid: 1,
    name: "A01",
    facility_id: "",
    site: { id: "s1", name: "HQ" },
    role: null,
    rack_type: null,
    status: null,
    location: null,
    width: 19,
    max_weight: null,
    max_weight_unit: "kg",
    total_weight_kg: 0,
    max_weight_kg: null,
    power: { available_w: 0, allocated_w: 0, maximum_w: 0 },
    u_height: 42,
    starting_unit: 1,
    desc_units: false,
    outer_width_mm: null,
    outer_depth_mm: null,
    description: "",
    device_count: 3,
    document_count: 0,
    used_units: 21,
    tags: [],
    custom_fields: {},
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    ...patch,
  }
}

function cell(id: RackColumnId, row: Rack) {
  const col = buildRackColumns({ include: [id] }).find((c) => c.id === id)
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    Rack,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

const level = (el: HTMLElement) =>
  el.querySelector<HTMLElement>("[data-slot=capacity-bar] > span")?.dataset
    .level

afterEach(cleanup)

describe("rack columns", () => {
  it("colours space on the shared scale", () => {
    expect(level(cell("utilisation", rack({ used_units: 21 })))).toBe("good")
    expect(level(cell("utilisation", rack({ used_units: 36 })))).toBe("warn")
    // 40 of 42 is 95.2 %: critical (the rounded-percent cell said amber).
    const full = cell("utilisation", rack({ used_units: 40 }))
    expect(level(full)).toBe("critical")
    expect(full.textContent).toBe("40/42")
  })

  it("offers Power hidden, read as demand over supply", () => {
    const power = buildRackColumns().find((c) => c.id === "power")
    expect(power?.meta).toMatchObject({ label: "Power", defaultHidden: true })
    const el = cell(
      "power",
      rack({ power: { available_w: 4_000, allocated_w: 3_900, maximum_w: 0 } })
    )
    expect(el.textContent).toBe("3.9 kW / 4 kW")
    expect(level(el)).toBe("critical")
    expect(cell("power", rack()).textContent).toBe("-")
  })

  it("leaves the embedded panes' columns as they were", () => {
    const ids = buildRackColumns({
      include: ["name", "site", "width", "used"],
    }).map((c) => c.id)
    expect(ids).toEqual(["name", "site", "width", "used"])
  })
})
