import { describe, expect, it } from "vitest"

import { cableState, cableStateMatches } from "./cable-state"

const resv = { id: "r1" }

describe("cableState", () => {
  it("free when nothing is set", () => {
    expect(cableState({})).toBe("free")
  })

  it("connected for any non-planned cable", () => {
    expect(cableState({ cable: { status: { slug: "connected" } } })).toBe(
      "connected"
    )
    expect(cableState({ cable: { status: null } })).toBe("connected")
  })

  it("reserved for a planned cable", () => {
    expect(cableState({ cable: { status: { slug: "planned" } } })).toBe(
      "reserved"
    )
  })

  it("reserved for a direct reservation on an uncabled port", () => {
    expect(cableState({ reservation: resv })).toBe("reserved")
  })

  it("a real cable outranks a stray reservation", () => {
    expect(
      cableState({
        cable: { status: { slug: "connected" } },
        reservation: resv,
      })
    ).toBe("connected")
  })

  it("mark_connected outranks a reservation", () => {
    expect(cableState({ mark_connected: true, reservation: resv })).toBe(
      "marked"
    )
  })

  it("marked counts as connected in filters", () => {
    expect(cableStateMatches("marked", "connected")).toBe(true)
    expect(cableStateMatches("reserved", "connected")).toBe(false)
  })
})
