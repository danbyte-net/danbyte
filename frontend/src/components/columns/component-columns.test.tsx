import { describe, expect, it } from "vitest"

import { buildConsolePortColumns } from "@/components/columns/console-port-columns"
import {
  buildFrontPortColumns,
  FRONT_PORT_COLUMNS,
} from "@/components/columns/front-port-columns"
import { buildInventoryItemColumns } from "@/components/columns/inventory-item-columns"
import { buildPowerOutletColumns } from "@/components/columns/power-outlet-columns"
import { buildPowerPortColumns } from "@/components/columns/power-port-columns"
import {
  buildRearPortColumns,
  REAR_PORT_COLUMNS,
} from "@/components/columns/rear-port-columns"
import { portOf } from "@/components/cable-trace-path"

// One column factory per device component type (#345): the device page's
// tabs build their tables from these, so the Columns menu can show and hide
// every data column while the row actions stay pinned.

const ids = (cols: { id?: string }[]) => cols.map((c) => c.id)
const hideable = (cols: { id?: string; enableHiding?: boolean }[]) =>
  cols.filter((c) => c.enableHiding !== false).map((c) => c.id)
const noop = () => {}
const perms = {
  canEdit: true,
  canDelete: true,
  canConnect: true,
  canReserve: true,
  onEdit: noop,
  onDelete: noop,
}

describe("device component column factories", () => {
  it("build the default columns, plus pinned actions when asked", () => {
    expect(ids(buildRearPortColumns())).toEqual(REAR_PORT_COLUMNS)
    expect(ids(buildFrontPortColumns())).toEqual(FRONT_PORT_COLUMNS)
    const rear = buildRearPortColumns({
      actions: { ...perms, canEditCable: true, onTrace: noop },
    })
    expect(ids(rear)).toEqual([...REAR_PORT_COLUMNS, "actions"])
    expect(hideable(rear)).toEqual(REAR_PORT_COLUMNS)

    for (const cols of [
      buildConsolePortColumns({
        header: "Console port",
        kind: "console_port",
        actions: perms,
      }),
      buildPowerPortColumns({ actions: perms }),
      buildPowerOutletColumns({ actions: perms }),
      buildInventoryItemColumns({ actions: { onEdit: noop, onDelete: noop } }),
    ]) {
      expect(cols.at(-1)?.id).toBe("actions")
      expect(cols.at(-1)?.enableHiding).toBe(false)
      expect(hideable(cols)).not.toContain("actions")
    }
  })

  it("take an include list, in its order", () => {
    expect(ids(buildFrontPortColumns({ include: ["name", "cable"] }))).toEqual([
      "name",
      "cable",
    ])
    expect(
      ids(buildPowerPortColumns({ include: ["max_draw", "name"] }))
    ).toEqual(["max_draw", "name"])
  })

  it("give every data column a value to search, sort and export", () => {
    for (const cols of [
      buildRearPortColumns(),
      buildFrontPortColumns(),
      buildConsolePortColumns({ header: "Console port", kind: "console_port" }),
      buildPowerPortColumns(),
      buildPowerOutletColumns(),
      buildInventoryItemColumns(),
    ])
      for (const c of cols) expect("accessorFn" in c, String(c.id)).toBe(true)
  })
})

describe("a traced port opens its own device tab", () => {
  const node = (id: string) => ({ id, data: { name: "p1" } })
  it("maps the trace's node prefix to the sub-tab", () => {
    expect(portOf(node("fp:1")).deviceSub).toBe("front-ports")
    expect(portOf(node("rp:1")).deviceSub).toBe("rear-ports")
    expect(portOf(node("csp:1")).deviceSub).toBe("console")
    expect(portOf(node("po:1")).deviceSub).toBe("power")
    expect(portOf(node("ap:1")).deviceSub).toBeUndefined()
    expect(portOf(node("if:1")).interfaceId).toBe("1")
  })
})
