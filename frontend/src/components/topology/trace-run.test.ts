import { describe, expect, it } from "vitest"

import {
  panelDev,
  panelTrace,
  panelTraceFromFar,
} from "./__fixtures__/panel-trace"
import { runOrder, traceMap } from "./trace-run"

// A trace map reads along its run: the devices in the order the run
// reaches them, a patch panel between the two ends of the cable it
// carries, and only the panel ports the run uses.

describe("runOrder", () => {
  it("places each device along the run, the panel between its ends", () => {
    // A cable's trace starts at the first end of the run the payload lists.
    expect(runOrder(panelTrace)).toEqual({
      [panelDev.srv]: 0,
      [panelDev.pp]: 1,
      [panelDev.dist]: 2,
    })
  })

  it("starts at the traced port", () => {
    expect(runOrder(panelTraceFromFar)).toEqual({
      [panelDev.dist]: 0,
      [panelDev.pp]: 1,
      [panelDev.srv]: 2,
    })
  })

  it("is empty for a trace with no ports", () => {
    expect(runOrder({ ...panelTrace, nodes: [], edges: [] })).toEqual({})
  })
})

describe("traceMap", () => {
  it("leaves out a panel's cables the run does not use", () => {
    const g = traceMap(panelTrace)!
    expect(g.edges.map((e) => e.data?.cable_id)).toEqual(
      panelTrace
        .device_graph!.edges.filter((e) => e.data?.marked)
        .map((e) => e.data?.cable_id)
    )
    expect(g.nodes).toBe(panelTrace.device_graph!.nodes)
  })

  it("keeps a map without panels as it came", () => {
    const g = panelTrace.device_graph!
    const plain = {
      ...panelTrace,
      device_graph: {
        ...g,
        nodes: g.nodes.map((n) => ({
          ...n,
          data: { ...n.data, panel: false, role: null },
        })),
      },
    }
    expect(traceMap(plain)).toBe(plain.device_graph)
  })

  it("has no map for a trace without one", () => {
    expect(traceMap({ ...panelTrace, device_graph: undefined })).toBe(undefined)
  })
})
