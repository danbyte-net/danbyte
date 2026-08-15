import { describe, expect, it } from "vitest"

import {
  discoverFields,
  evaluate,
  format,
  fromBuilder,
  parse,
  toBuilder,
  type Expr,
} from "./filter-expr"

const rows = [
  {
    name: "core-sw1",
    status: { name: "Active", color: "#10b981" },
    site: { name: "CPH-01" },
    tags: [{ name: "core", slug: "core" }],
    due_date: "2026-08-10",
    weight: 10,
    enabled: true,
    description: "",
  },
  {
    name: "edge-fw2",
    status: { name: "Offline" },
    site: { name: "AAR-02" },
    tags: [],
    due_date: "2026-09-01",
    weight: 200,
    enabled: false,
    description: "spare unit",
  },
]

const match = (src: string) =>
  rows.filter((r) => evaluate(parse(src) as Expr, r)).map((r) => r.name)

describe("parse + evaluate", () => {
  it("compares nested names case-insensitively", () => {
    expect(match("status.name = active")).toEqual(["core-sw1"])
    expect(match("status = offline")).toEqual(["edge-fw2"])
  })

  it("supports contains, negation and quoted values", () => {
    expect(match('site.name ~ "cph"')).toEqual(["core-sw1"])
    expect(match("name !~ fw")).toEqual(["core-sw1"])
    expect(match('description = "spare unit"')).toEqual(["edge-fw2"])
  })

  it("compares numbers numerically and dates lexically", () => {
    expect(match("weight > 50")).toEqual(["edge-fw2"])
    expect(match("due_date < 2026-08-15")).toEqual(["core-sw1"])
  })

  it("handles booleans, empties and arrays", () => {
    expect(match("enabled = true")).toEqual(["core-sw1"])
    expect(match("tags ~ core")).toEqual(["core-sw1"])
    expect(match("tags is empty")).toEqual(["edge-fw2"])
    expect(match("description is not empty")).toEqual(["edge-fw2"])
  })

  it('offers "is / is not" as = / != sugar', () => {
    expect(match("status is active")).toEqual(["core-sw1"])
    expect(match("status is not active")).toEqual(["edge-fw2"])
  })

  it("binds and tighter than or, with parentheses to override", () => {
    expect(match("status = offline or status = active and weight > 50")).toEqual(
      ["core-sw1", "edge-fw2"].filter(
        (n) => n === "edge-fw2" // offline, or (active and heavy → nobody)
      )
    )
    expect(
      match("(status = offline or status = active) and weight > 50")
    ).toEqual(["edge-fw2"])
  })

  it("rejects malformed input with a position", () => {
    expect(() => parse("status = ")).toThrow(/value/i)
    expect(() => parse("(status = a")).toThrow(/\)/)
    expect(() => parse("status ?? a")).toThrow(/character/i)
  })

  it("returns null for blank input", () => {
    expect(parse("   ")).toBeNull()
  })
})

describe("format round-trips", () => {
  it("re-parses to the same behaviour, keeping needed parens", () => {
    const src = '(site.name ~ cph or tags ~ core) and status != "Offline"'
    const ast = parse(src) as Expr
    const printed = format(ast)
    expect(rows.filter((r) => evaluate(parse(printed) as Expr, r))).toEqual(
      rows.filter((r) => evaluate(ast, r))
    )
  })
})

describe("builder view", () => {
  it("maps a flat AND to rows and back", () => {
    const ast = parse("status = active and weight > 5") as Expr
    const b = toBuilder(ast)
    expect(b?.op).toBe("and")
    expect(b?.rules).toHaveLength(2)
    const back = fromBuilder(b!.op, b!.rules)
    expect(format(back)).toBe(format(ast))
  })

  it("declines nested expressions", () => {
    const ast = parse("a = 1 and (b = 2 or c = 3)") as Expr
    expect(toBuilder(ast)).toBeNull()
  })
})

describe("discoverFields", () => {
  it("finds scalars, nested names and array fields, skipping ids", () => {
    const fields = discoverFields(rows)
    const paths = fields.map((f) => f.path)
    expect(paths).toContain("status.name")
    expect(paths).toContain("status")
    expect(paths).toContain("tags")
    expect(paths).toContain("weight")
    expect(paths).toContain("status.color")
    expect(fields.find((f) => f.path === "weight")?.kind).toBe("number")
    expect(fields.find((f) => f.path === "enabled")?.kind).toBe("boolean")
  })
})
