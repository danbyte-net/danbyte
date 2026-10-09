import { describe, expect, it } from "vitest"

import { asArray, asRecord } from "./utils"

// Spreadsheet imports before 0.17.2 could store "" in JSON list and object
// columns (#354); readers treat any other shape as empty.
describe("asArray", () => {
  it("passes a list through", () => {
    const list = ["a", "b"]
    expect(asArray(list)).toBe(list)
  })

  it("reads anything else as empty", () => {
    for (const bad of ["", "a,b", null, undefined, {}, 0]) {
      expect(asArray(bad as never)).toEqual([])
    }
  })
})

describe("asRecord", () => {
  it("passes an object through", () => {
    const obj = { "1": { label: "x" } }
    expect(asRecord(obj)).toBe(obj)
  })

  it("reads anything else as empty", () => {
    for (const bad of ["", "x", null, undefined, [], 0]) {
      expect(asRecord(bad as never)).toEqual({})
    }
  })
})
