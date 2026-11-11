import { describe, expect, it } from "vitest"

import { answersFor } from "./allowed-hosts"

describe("answersFor", () => {
  it("matches like Django's validate_host", () => {
    const allowed = ["danbyte.example", ".lan"]
    expect(answersFor("danbyte.example", allowed)).toBe(true)
    expect(answersFor("DANBYTE.example.", allowed)).toBe(true)
    expect(answersFor("ipam.lan", allowed)).toBe(true)
    expect(answersFor("lan", allowed)).toBe(true)
    expect(answersFor("other.example", allowed)).toBe(false)
    expect(answersFor("evillan", allowed)).toBe(false)
    expect(answersFor("anything", ["*"])).toBe(true)
  })

  it("says nothing without patterns", () => {
    expect(answersFor("x.example", [])).toBe(true)
  })
})
