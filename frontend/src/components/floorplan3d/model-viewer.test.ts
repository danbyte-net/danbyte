import { describe, expect, it } from "vitest"

import { MODEL_PORT_UNDEFINED, modelPortHex } from "@/lib/model-ports"

import { MODEL_PORT_TEMPLATE } from "./device-model-port-markers"
import { contactShadowFor, isFaceView, presetCamera } from "./model-viewer"
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

  it("light the model as the studio renders it", () => {
    // Under AgX the environment may be stronger than the room's 0.35
    // without the cages reading near white.
    expect(STUDIO_LIGHTS.environment).toBeGreaterThan(0)
    expect(STUDIO_LIGHTS.environment).toBeLessThanOrEqual(1)
  })
})

describe("contactShadowFor", () => {
  it("reaches past the footprint, just under the floor", () => {
    const s = contactShadowFor([0.44, 0.044, 0.5])
    expect(s.scale).toBeCloseTo(0.8)
    expect(s.y).toBeLessThan(0)
    expect(s.y).toBeGreaterThan(-0.001)
  })

  it("keeps its soft edge in step with the model", () => {
    const small = contactShadowFor([0.44, 0.044, 0.5])
    const big = contactShadowFor([0.88, 0.088, 1])
    expect(big.blur).toBeCloseTo(small.blur)
    expect(small.blur * (small.scale / 256)).toBeCloseTo(0.5 * 0.04)
  })

  it("catches a 1U device's whole height", () => {
    expect(contactShadowFor([0.44, 0.044, 0.5]).far).toBeGreaterThanOrEqual(
      0.04
    )
    expect(contactShadowFor([0.6, 2, 1]).far).toBeCloseTo(1.6)
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
