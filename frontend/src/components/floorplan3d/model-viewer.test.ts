import { describe, expect, it } from "vitest"

import { MODEL_PORT_UNDEFINED, modelPortHex } from "@/lib/model-ports"

import { MODEL_PORT_TEMPLATE } from "./device-model-port-markers"
import { isFaceView, presetCamera } from "./model-viewer"
import { STUDIO_LIGHTS } from "./studio"

// The viewer's camera presets and light; its markers are
// the room's, coloured by port state.

describe("presetCamera", () => {
  const size: [number, number, number] = [0.44, 0.044, 0.3]

  it("looks at the model's middle from the front three-quarter", () => {
    const iso = presetCamera(size)
    expect(iso.target).toEqual([0, 0.022, 0])
    // The room's front is −Z.
    expect(iso.position[0]).toBeGreaterThan(0)
    expect(iso.position[2]).toBeLessThan(0)
  })
})

describe("view presets", () => {
  it("are orthographic for a face, perspective for 3D", () => {
    expect(isFaceView("front")).toBe(true)
    expect(isFaceView("rear")).toBe(true)
    expect(isFaceView("top")).toBe(true)
    expect(isFaceView("iso")).toBe(false)
  })

  it("light the model as the room does", () => {
    // The room's studio environment is 0.35 (stage.tsx); at full strength
    // shiny cages read near white.
    expect(STUDIO_LIGHTS.environment).toBe(0.35)
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
