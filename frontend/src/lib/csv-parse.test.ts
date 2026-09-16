import { describe, expect, it } from "vitest"

import { parseCsv } from "./csv-parse"

describe("parseCsv", () => {
  it("reads a header and its rows", () => {
    expect(parseCsv("name,site\naalborg-sw1,Aalborg\n")).toEqual([
      ["name", "site"],
      ["aalborg-sw1", "Aalborg"],
    ])
  })

  it("keeps commas, newlines and quotes inside a quoted field", () => {
    expect(parseCsv('a,b\n"one, two","he said ""hi""\nagain"')).toEqual([
      ["a", "b"],
      ["one, two", 'he said "hi"\nagain'],
    ])
  })

  it("keeps empty cells", () => {
    expect(parseCsv("a,b,c\n1,,3")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
    ])
  })

  it("stops at the row cap", () => {
    const rows = parseCsv("h\n" + "x\n".repeat(50), 10)
    expect(rows).toHaveLength(10)
  })

  it("survives CRLF and a missing trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })
})
