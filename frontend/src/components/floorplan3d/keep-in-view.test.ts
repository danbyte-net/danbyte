import { describe, expect, it } from "vitest"

import { shiftIntoView } from "./keep-in-view"

const bounds = { left: 0, top: 0, right: 400, bottom: 300 }

describe("shiftIntoView", () => {
  it("leaves a card inside alone", () => {
    expect(
      shiftIntoView({ left: 50, top: 50, right: 150, bottom: 80 }, bounds)
    ).toEqual({ x: 0, y: 0 })
  })
  it("pulls a card back from the right and bottom edges", () => {
    expect(
      shiftIntoView({ left: 350, top: 280, right: 450, bottom: 310 }, bounds)
    ).toEqual({
      x: -58,
      y: -18,
    })
  })
  it("pushes a card in from the left and top", () => {
    expect(
      shiftIntoView({ left: -20, top: -5, right: 80, bottom: 25 }, bounds)
    ).toEqual({ x: 28, y: 13 })
  })
  it("keeps the left edge visible when the card is wider than the canvas", () => {
    expect(
      shiftIntoView({ left: 100, top: 10, right: 600, bottom: 40 }, bounds).x
    ).toBe(-92)
  })
})
