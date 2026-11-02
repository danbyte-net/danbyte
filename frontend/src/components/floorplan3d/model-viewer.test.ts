import { describe, expect, it } from "vitest"

import {
  MODEL_PORT_UNDEFINED,
  PORT_MARKER_M,
  modelPortHex,
} from "@/lib/model-ports"

import { MODEL_PORT_TEMPLATE } from "./device-model-port-markers"
import { presetCamera, viewerMarkerM } from "./model-viewer"

// The Overview viewer's camera presets and marker sizing; its markers are
// the room's, coloured by port state.

describe("presetCamera", () => {
  const size: [number, number, number] = [0.44, 0.044, 0.3]

  it("looks at the model's middle from the preset side", () => {
    const front = presetCamera("front", size)
    expect(front.target).toEqual([0, 0.022, 0])
    // The room's front is −Z.
    expect(front.position[2]).toBeLessThan(0)
    expect(front.position[0]).toBe(0)
    expect(presetCamera("rear", size).position[2]).toBeGreaterThan(0)
    const top = presetCamera("top", size)
    expect(top.position[1]).toBeGreaterThan(size[1])
    const fit = presetCamera("fit", size)
    expect(fit.position[0]).toBeGreaterThan(0)
    expect(fit.position[2]).toBeLessThan(0)
  })
})

describe("viewerMarkerM", () => {
  it("is the room's size on a device, larger on a big model", () => {
    expect(viewerMarkerM([0.44, 0.044, 0.3])).toBe(PORT_MARKER_M)
    expect(viewerMarkerM([2, 1, 1])).toBeCloseTo(2 / 90)
  })
})

describe("marker colours", () => {
  const port = {
    id: "i1",
    enabled: true,
    connected: true,
    speed: "1G",
    type: "1000base-t",
  }

  it("follow port state, neutral on a type", () => {
    const cabled = modelPortHex(port)
    const disabled = modelPortHex({ ...port, enabled: false })
    expect(cabled).not.toBe(disabled)
    expect(modelPortHex({ ...port, id: null })).toBe(MODEL_PORT_UNDEFINED)
    const down = modelPortHex(port, { oper_status: "down", admin_status: "up" })
    expect(down).not.toBe(cabled)
    expect(MODEL_PORT_TEMPLATE).not.toBe(MODEL_PORT_UNDEFINED)
  })
})
