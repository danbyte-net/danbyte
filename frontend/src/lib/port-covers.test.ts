import { describe, expect, it } from "vitest"

import { coverHidden, coversKey, portCoverName } from "./port-covers"

describe("port covers", () => {
  it("reads cover:port: names only", () => {
    expect(portCoverName("cover:port:StackPort1/1")).toBe("StackPort1/1")
    expect(portCoverName("cover:port:")).toBeNull()
    expect(portCoverName("cover:StackPort1/1")).toBeNull()
    expect(portCoverName("port:StackPort1/1")).toBeNull()
    expect(portCoverName(undefined)).toBeNull()
  })

  it("hides only what the payload names, chassis and bay apart", () => {
    const dev = {
      covers: ["StackPort1/1"],
      bay_covers: { "NM-1": ["Te1/1/1"] },
    }
    expect(coverHidden(dev, "StackPort1/1")).toBe(true)
    expect(coverHidden(dev, "StackPort1/2")).toBe(false)
    expect(coverHidden(dev, "Te1/1/1", "NM-1")).toBe(true)
    expect(coverHidden(dev, "Te1/1/1")).toBe(false)
    expect(coverHidden(dev, "StackPort1/1", "NM-1")).toBe(false)
  })

  it("keeps every cover without a payload", () => {
    expect(coverHidden(null, "StackPort1/1")).toBe(false)
    expect(coverHidden(undefined, "StackPort1/1")).toBe(false)
    expect(coverHidden({}, "StackPort1/1")).toBe(false)
  })

  it("keys a payload stably", () => {
    const a = { covers: ["b", "a"], bay_covers: { y: ["2"], x: ["1"] } }
    const b = { covers: ["a", "b"], bay_covers: { x: ["1"], y: ["2"] } }
    expect(coversKey(a)).toBe(coversKey(b))
    expect(coversKey(a)).not.toBe(coversKey({ covers: ["a"] }))
    expect(coversKey(null)).toBe("")
  })
})
