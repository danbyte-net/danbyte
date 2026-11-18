import { describe, expect, it } from "vitest"

import {
  SCENE_TRIANGLE_BUDGET,
  SCENE_TRIANGLE_BUDGET_FULL,
  budgetFor,
} from "./device-model"

describe("budgetFor", () => {
  it("gives a capable GPU the full budget", () => {
    expect(budgetFor("ANGLE (NVIDIA GeForce RTX 3060)", 8)).toBe(
      SCENE_TRIANGLE_BUDGET_FULL
    )
    expect(budgetFor("Apple M2")).toBe(SCENE_TRIANGLE_BUDGET_FULL)
  })

  it("keeps the low budget on software, low memory or no WebGL 2", () => {
    expect(budgetFor("Google SwiftShader", 8)).toBe(SCENE_TRIANGLE_BUDGET)
    expect(budgetFor("llvmpipe (LLVM 15.0.7)")).toBe(SCENE_TRIANGLE_BUDGET)
    expect(budgetFor("Intel UHD 620", 2)).toBe(SCENE_TRIANGLE_BUDGET)
    expect(budgetFor(null)).toBe(SCENE_TRIANGLE_BUDGET)
  })

  it("follows the override", () => {
    expect(budgetFor("Google SwiftShader", 8, "high")).toBe(
      SCENE_TRIANGLE_BUDGET_FULL
    )
    expect(budgetFor("Apple M2", 8, "low")).toBe(SCENE_TRIANGLE_BUDGET)
    expect(budgetFor("Apple M2", 8, "3000000")).toBe(3_000_000)
    expect(budgetFor("Apple M2", 8, "nonsense")).toBe(
      SCENE_TRIANGLE_BUDGET_FULL
    )
  })
})
