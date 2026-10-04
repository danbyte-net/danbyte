import { describe, expect, it } from "vitest"

import {
  picksUnderWildcard,
  stateToTypes,
  typesToState,
  WILDCARD,
} from "./permission-types"

const EXCLUDED = ["user", "group", "objectpermission"]

describe("permission object types", () => {
  it("round-trips the Administrator grant with its access types", () => {
    const stored = [WILDCARD, "user", "group", "objectpermission"]
    const state = typesToState(stored)
    expect(state.allTypes).toBe(true)
    expect(state.picked).toEqual(["user", "group", "objectpermission"])
    expect(stateToTypes(state)).toEqual(stored)
  })

  it("round-trips a bare wildcard and a named list", () => {
    expect(stateToTypes(typesToState([WILDCARD]))).toEqual([WILDCARD])
    expect(stateToTypes(typesToState(["prefix", "vlan"]))).toEqual([
      "prefix",
      "vlan",
    ])
  })

  it("keeps only the types the wildcard does not reach when it is switched on", () => {
    expect(
      picksUnderWildcard(
        ["prefix", "user", "vlan", "objectpermission"],
        EXCLUDED
      )
    ).toEqual(["user", "objectpermission"])
    expect(picksUnderWildcard(["prefix"], EXCLUDED)).toEqual([])
  })
})
