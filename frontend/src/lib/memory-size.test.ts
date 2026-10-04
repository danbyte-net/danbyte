import { describe, expect, it } from "vitest"

import { formatMemory } from "./memory-size"

const GIB = 1024 ** 3

describe("formatMemory", () => {
  it("reads a BMC's binary bytes and the form's decimal bytes alike", () => {
    expect(formatMemory(32 * GIB)).toBe("32 GB")
    expect(formatMemory(32_000_000_000)).toBe("32 GB")
  })

  it("keeps a total in GB", () => {
    expect(formatMemory(Array(16).fill(64 * GIB))).toBe("1024 GB")
    expect(formatMemory([64 * GIB, 64_000_000_000])).toBe("128 GB")
  })

  it("shows one decimal when the figure is not whole", () => {
    expect(formatMemory(512 * 1024 * 1024)).toBe("0.5 GB")
    expect(formatMemory(33_300_000_000)).toBe("33.3 GB")
  })

  it("is empty for nothing", () => {
    expect(formatMemory(null)).toBe("")
    expect(formatMemory(0)).toBe("")
    expect(formatMemory([])).toBe("")
  })
})
