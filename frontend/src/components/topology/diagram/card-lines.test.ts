import { describe, expect, it } from "vitest"

import {
  CARD_LINE_GROUPS,
  cardLineOptions,
  inheritedCardLines,
  rolesWithOwnLines,
} from "./card-lines"

const CONFIG = {
  fields: ["monitor", "primary_ip", "loopback", "serial"],
  role_overrides: {
    "role:spine": ["loopback"],
    "role:edge_fw": [],
  },
}

describe("inheritedCardLines", () => {
  it("uses the view's list first, even over a role's", () => {
    expect(inheritedCardLines(CONFIG, "spine", ["serial"])).toEqual({
      fields: ["serial"],
      from: { level: "view" },
    })
  })

  it("counts a view's empty list (name only) as its own", () => {
    expect(inheritedCardLines(CONFIG, "spine", [])).toEqual({
      fields: [],
      from: { level: "view" },
    })
  })

  it("then the role's own list, a slug with an underscore included", () => {
    expect(inheritedCardLines(CONFIG, "spine")).toEqual({
      fields: ["loopback"],
      from: { level: "role", slug: "spine" },
    })
    expect(inheritedCardLines(CONFIG, "edge_fw", null)).toEqual({
      fields: [],
      from: { level: "role", slug: "edge_fw" },
    })
  })

  it("else All devices - for a role without a list, and for no role", () => {
    const all = { fields: CONFIG.fields, from: { level: "all" } }
    expect(inheritedCardLines(CONFIG, "leaf")).toEqual(all)
    expect(inheritedCardLines(CONFIG, null)).toEqual(all)
    expect(inheritedCardLines(CONFIG)).toEqual(all)
  })

  it("returns copies, so an edit never reaches the config", () => {
    const got = inheritedCardLines(CONFIG, "spine")
    got.fields.push("serial")
    expect(CONFIG.role_overrides["role:spine"]).toEqual(["loopback"])
  })

  it("counts the roles with lines of their own", () => {
    expect(rolesWithOwnLines(CONFIG)).toBe(2)
    expect(rolesWithOwnLines({ role_overrides: {} })).toBe(0)
  })
})

describe("cardLineOptions", () => {
  const vocab = ["status", "monitor", "primary_ip", "serial", "tags", "uptime"]

  it("offers the vocabulary, then the custom fields", () => {
    const o = cardLineOptions(vocab, {
      cf_rack_unit: { label: "Rack unit", hint: "Custom field · device" },
    })
    expect(o.available).toEqual([...vocab, "cf_rack_unit"])
    expect(o.groups.map((g) => g.title)).toEqual([
      ...CARD_LINE_GROUPS.map((g) => g.title),
      "Custom fields",
    ])
    expect(o.groups.at(-1)?.keys).toEqual(["cf_rack_unit"])
  })

  it("puts a key the picker does not know under Other", () => {
    const o = cardLineOptions(vocab, {})
    expect(o.groups.find((g) => g.title === "Other")?.keys).toEqual([
      "tags",
      "uptime",
    ])
    expect(o.groups.some((g) => g.title === "Custom fields")).toBe(false)
  })

  it("names lines as the card does, with a hint", () => {
    const o = cardLineOptions(vocab, {
      cf_rack_unit: { label: "Rack unit", hint: "Custom field · device" },
    })
    expect(o.meta("primary_ip")).toEqual({
      label: "IP",
      hint: "Primary address",
    })
    expect(o.meta("cf_rack_unit")).toEqual({
      label: "Rack unit",
      hint: "Custom field · device",
    })
    // A custom field this tenant cannot see any more still gets a name.
    expect(o.meta("cf_old_thing")).toEqual({
      label: "Old thing",
      hint: "Custom field",
    })
    expect(o.meta("uptime").hint).toBe("")
  })
})
