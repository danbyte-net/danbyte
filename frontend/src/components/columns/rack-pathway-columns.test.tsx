// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ResolvedPathway } from "@/lib/api"
import { buildRackPathwayColumns } from "./rack-pathway-columns"
import type { RackPathwayColumnId } from "./rack-pathway-columns"

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    params,
  }: {
    children: ReactNode
    to: string
    params?: { id?: string }
  }) => <a href={to.replace("$id", params?.id ?? "")}>{children}</a>,
}))

function pathway(patch: Partial<ResolvedPathway> = {}): ResolvedPathway {
  return {
    key: "path:vertical:left:rear",
    id: null,
    source: "kit",
    kind: "vertical",
    subkind: "channel",
    side: "left",
    face: "rear",
    surface: "",
    u_from: 1,
    u_to: 42,
    offset_mm: null,
    depth_mm: null,
    x_mm: null,
    y_mm: null,
    inner_w_mm: 52,
    inner_d_mm: 88,
    fill_limit_pct: 40,
    name: "",
    description: "",
    label: "Left rear",
    hidden: false,
    addon: false,
    orphan: false,
    overridden: [],
    accessory_type: null,
    device: null,
    ...patch,
  }
}

function cell(id: RackPathwayColumnId, row: ResolvedPathway) {
  const col = buildRackPathwayColumns({ include: [id] })[0] as {
    cell?: unknown
    accessorFn?: (r: ResolvedPathway) => unknown
  }
  const ctx = {
    row: { original: row },
    getValue: () => col.accessorFn?.(row),
  } as unknown as CellContext<ResolvedPathway, unknown>
  const content = col.cell
    ? flexRender(col.cell as never, ctx)
    : String(ctx.getValue())
  return render(<div>{content}</div>).container
}

afterEach(cleanup)

describe("rack pathway columns", () => {
  it("one column per id, actions last", () => {
    const cols = buildRackPathwayColumns({
      include: ["name", "source"],
      actions: { onEdit: () => {} },
    })
    expect(cols.map((c) => c.id)).toEqual(["name", "source", "actions"])
  })

  it("marks the source as a squarish badge, and a change", () => {
    const el = cell("source", pathway({ overridden: ["inner_w_mm"] }))
    const badges = el.querySelectorAll("[data-slot=badge]")
    expect([...badges].map((b) => b.textContent)).toEqual(["Kit", "Changed"])
    expect(el.querySelector(".rounded-full")).toBeNull()
    expect(cell("source", pathway({ source: "manual" })).textContent).toBe(
      "Manual"
    )
  })

  it("names hidden add-ons and pathways the kit lost", () => {
    expect(
      cell("name", pathway({ hidden: true, addon: true })).textContent
    ).toBe("Left rearAdd-on")
    expect(cell("name", pathway({ orphan: true })).textContent).toBe(
      "Left rearNot in kit"
    )
  })

  it("reads units, size, fill and a channel's devices", () => {
    expect(cell("units", pathway()).textContent).toBe("U1-U42")
    expect(cell("size", pathway()).textContent).toBe("52 × 88 mm")
    expect(cell("fill", pathway()).textContent).toBe("40 %")
    const ch = pathway({
      kind: "channel",
      devices: [{ id: "d1", name: "pdu-a" }],
    })
    expect(cell("fill", ch).textContent).toBe("-")
    const el = cell("devices", ch)
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/devices/d1")
    expect(
      cell("where", pathway({ kind: "entry", surface: "bottom" })).textContent
    ).toBe("Floor")
  })
})
