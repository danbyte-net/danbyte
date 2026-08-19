import { describe, expect, it } from "vitest"

import { classifyRenderer } from "./render-quality"

describe("classifyRenderer - GPU string → effects budget", () => {
  it("software rasterisers land on Low", () => {
    expect(classifyRenderer("Google SwiftShader", 1)).toBe("low")
    expect(classifyRenderer("llvmpipe (LLVM 15.0.7, 256 bits)", 2)).toBe("low")
    expect(classifyRenderer("Microsoft Basic Render Driver", 1)).toBe("low")
  })

  it("known discrete GPUs and Apple silicon land on High", () => {
    expect(
      classifyRenderer("ANGLE (NVIDIA GeForce RTX 3070 Direct3D11)", 1)
    ).toBe("high")
    expect(classifyRenderer("AMD Radeon RX 6800 XT", 1)).toBe("high")
    expect(classifyRenderer("Apple M2 Pro", 1)).toBe("high")
  })

  it("unknown/integrated strings get Medium, High on hi-DPI machines", () => {
    expect(classifyRenderer("ANGLE (Intel(R) UHD Graphics 620)", 1)).toBe(
      "medium"
    )
    expect(classifyRenderer("", 1)).toBe("medium")
    expect(classifyRenderer("ANGLE (Intel(R) Iris(R) Xe)", 2)).toBe("high")
  })
})
