// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext, ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PowerPanel } from "@/lib/api"
import { buildPowerPanelColumns } from "./power-panel-columns"
import type { PowerPanelColumnId } from "./power-panel-columns"

// The /power-panels list builds its columns here, like the feeds list does
// from power-feed-columns: the same columns in the same order, the name
// opening the panel's own page.

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

const PANEL: PowerPanel = {
  id: "p1",
  numid: 3,
  name: "MDB-1",
  site: { id: "s1", name: "HQ" },
  location: { id: "l1", name: "Plant room" },
  comments: "",
  feed_count: 4,
  tags: [],
  custom_fields: {},
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}

function cell(id: PowerPanelColumnId) {
  const col = buildPowerPanelColumns({ include: [id] }).find((c) => c.id === id)
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: PANEL } } as unknown as CellContext<
    PowerPanel,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

const ids = (cols: ColumnDef<PowerPanel, unknown>[]) => cols.map((c) => c.id)

afterEach(cleanup)

describe("power panel columns", () => {
  it("lists the columns in order, # and selection only when asked", () => {
    expect(ids(buildPowerPanelColumns())).toEqual([
      "name",
      "site",
      "location",
      "feeds",
      "comments",
      "tags",
    ])
    expect(
      ids(
        buildPowerPanelColumns({
          humanIds: true,
          selection: true,
          actions: { onDelete: () => {} },
        })
      )
    ).toEqual([
      "select",
      "numid",
      "name",
      "site",
      "location",
      "feeds",
      "comments",
      "tags",
      "actions",
    ])
  })

  it("opens the panel's own page from its name", () => {
    expect(cell("name").querySelector("a")?.getAttribute("href")).toBe(
      "/power-panels/p1"
    )
  })

  it("reads the feed count and a dash for no comments", () => {
    expect(cell("feeds").textContent).toBe("4")
    expect(cell("comments").textContent).toBe("-")
  })
})
