// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext, ColumnDef } from "@tanstack/react-table"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { CoolingIntake, CoolingOutflow, CoolingPath } from "@/lib/api"
import {
  buildCoolingIntakeColumns,
  buildCoolingOutflowColumns,
  intakeUpstreamText,
} from "./cooling-component-columns"
import type {
  CoolingIntakeColumnId,
  CoolingOutflowColumnId,
} from "./cooling-component-columns"
import { coolingPathText, CoolingPathHops } from "@/components/cooling-path"
import { FlowFigure } from "@/components/cells/flow-figure"

// Cooling intakes and outflows (#434): an intake reads where its coolant
// comes from - a feed or another device's outflow - and an outflow the
// intakes it serves; paths read upstream first.

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

const base = {
  device: { id: "d1", name: "srv1" },
  label: "",
  connector: "qd-3/8",
  connector_display: 'QD 3/8"',
  diameter_mm: 10,
  max_flow_lpm: "8.5",
  description: "",
  tags: [],
  custom_fields: {},
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}

function intake(patch: Partial<CoolingIntake> = {}): CoolingIntake {
  return {
    ...base,
    id: "i1",
    name: "Supply",
    cooling_feed: null,
    outflow: null,
    ...patch,
  }
}

function outflow(patch: Partial<CoolingOutflow> = {}): CoolingOutflow {
  return {
    ...base,
    id: "o1",
    name: "Sec 1",
    intake: { id: "i9", name: "Primary" },
    served: [],
    ...patch,
  }
}

function cell<T>(col: ColumnDef<T> | undefined, row: T) {
  if (!col) throw new Error("no column")
  const ctx = { row: { original: row } } as unknown as CellContext<T, unknown>
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

const intakeCell = (id: CoolingIntakeColumnId, row: CoolingIntake) =>
  cell(buildCoolingIntakeColumns({ include: [id] })[0], row)
const outflowCell = (id: CoolingOutflowColumnId, row: CoolingOutflow) =>
  cell(buildCoolingOutflowColumns({ include: [id] })[0], row)

afterEach(cleanup)

describe("cooling intake columns", () => {
  it("links the feed it takes coolant from", () => {
    const row = intake({
      cooling_feed: {
        id: "f1",
        name: "Loop A",
        source: { id: "s1", name: "CRAH-1" },
      },
    })
    const el = intakeCell("fed_from", row)
    expect(el.querySelector("a")?.getAttribute("href")).toBe(
      "/cooling-feeds/f1"
    )
    expect(intakeUpstreamText(row)).toBe("Loop A")
  })

  it("names the CDU and its outflow, else a dash", () => {
    const row = intake({
      outflow: { id: "o1", name: "Sec 1", device: { id: "c1", name: "cdu1" } },
    })
    const el = intakeCell("fed_from", row)
    expect(el.textContent).toBe("cdu1 Sec 1")
    expect(el.querySelector("a")?.getAttribute("href")).toBe("/devices/c1")
    expect(intakeCell("fed_from", intake()).textContent).toBe("-")
  })

  it("reads connector, bore and flow with their units", () => {
    expect(intakeCell("connector", intake()).textContent).toBe('QD 3/8"')
    expect(intakeCell("diameter", intake()).textContent).toBe("10 mm")
    expect(intakeCell("flow", intake()).textContent).toBe("8.5 L/min")
    expect(intakeCell("flow", intake({ max_flow_lpm: null })).textContent).toBe(
      "-"
    )
  })

  it("adds the actions column only when asked", () => {
    expect(buildCoolingIntakeColumns().map((c) => c.id)).not.toContain(
      "actions"
    )
    const cols = buildCoolingIntakeColumns({
      actions: {
        canEdit: true,
        canDelete: true,
        onEdit: () => {},
        onDelete: () => {},
      },
    })
    expect(cols.at(-1)?.id).toBe("actions")
  })
})

describe("cooling outflow columns", () => {
  it("names its intake and the devices it serves", () => {
    expect(outflowCell("fed_by", outflow()).textContent).toBe("Primary")
    const el = outflowCell(
      "serves",
      outflow({
        served: [
          { id: "x", name: "in", device: { id: "d2", name: "srv2" } },
          { id: "y", name: "in", device: { id: "d3", name: "srv3" } },
        ],
      })
    )
    expect([...el.querySelectorAll("a")].map((a) => a.textContent)).toEqual([
      "srv2",
      "srv3",
    ])
  })
})

describe("cooling path", () => {
  const path: CoolingPath = {
    intake: { id: "i1", name: "in" },
    status: "fed",
    hops: [
      { kind: "source", id: "s1", name: "CRAH-1" },
      { kind: "feed", hidden: true },
      {
        kind: "device",
        id: "c1",
        name: "cdu1",
        intake: null,
        outflow: { id: "o1", name: "Sec 1" },
      },
      {
        kind: "device",
        id: "d1",
        name: "srv1",
        intake: { id: "i1", name: "in" },
        outflow: null,
      },
    ],
  }

  it("reads upstream first and hides what the caller may not view", () => {
    expect(coolingPathText(path)).toBe("CRAH-1 → … → cdu1 → srv1")
    const el = render(<CoolingPathHops path={path} />).container
    expect(
      [...el.querySelectorAll("a")].map((a) => a.getAttribute("href"))
    ).toEqual(["/cooling-sources/s1", "/devices/c1", "/devices/d1"])
    expect(el.textContent).toContain("Hidden")
  })
})

describe("flow figure", () => {
  it("measures the intakes' flow against the feed's", () => {
    const el = render(
      <FlowFigure flow={{ connected_lpm: 60, rated_lpm: 50, intakes: 2 }} />
    ).container
    expect(el.textContent).toBe("60 / 50 L/min")
    expect(el.querySelector(".text-destructive")).toBeTruthy()
    cleanup()
    expect(
      render(
        <FlowFigure
          flow={{ connected_lpm: null, rated_lpm: 42.5, intakes: 0 }}
        />
      ).container.textContent
    ).toBe("42.5 L/min")
  })
})
