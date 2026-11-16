import { describe, expect, it } from "vitest"

import { authored, longForm, NameMatcher } from "./anchor-names"
import cases from "./anchor-names.cases.json"

/* The cases api/tests_anchor_names.py runs through the server's copy. */

describe("authored", () => {
  for (const [name, want] of cases.authored) {
    it(`${name} → ${want}`, () => {
      expect(authored(name)).toBe(want)
    })
  }
})

describe("longForm", () => {
  for (const [name, want] of cases.long_form) {
    it(`${name} → ${want}`, () => {
      expect(longForm(name)).toBe(want)
    })
  }
})

describe("NameMatcher", () => {
  for (const c of cases.match) {
    it(c.why, () => {
      const m = new NameMatcher(c.names)
      expect(m.candidates(c.anchor)).toEqual(c.candidates)
      expect(m.resolve(c.anchor)).toBe(c.resolve)
    })
  }
})
