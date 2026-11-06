import { describe, expect, it } from "vitest"

import {
  bandOfCards,
  lineResolver,
  lineTypeOf,
  nodeLines,
  resolveLine,
} from "./line-source"
import type { LineEnd } from "./line-source"

// Which line a cable takes: its own, then its ends' devices', then the
// bands their cards stand in, then the view's. At each level one end set
// wins; both set and different, the source (A) end does.

const A = "a0000000-0000-4000-8000-000000000001"
const B = "b0000000-0000-4000-8000-000000000002"
const end = (id: string, o: Omit<LineEnd, "id"> = {}): LineEnd => ({
  id,
  ...o,
})

describe("resolveLine", () => {
  it("is the view's line when nothing else is set", () => {
    expect(resolveLine("straight", undefined, end(A), end(B))).toEqual({
      line: "straight",
      from: { kind: "view" },
    })
  })

  it("is the link's own line over everything", () => {
    expect(
      resolveLine(
        "straight",
        "cyclical",
        end(A, { line: "elbow", band: { id: "r1", line: "bendy" } }),
        end(B, { line: "bendy" })
      )
    ).toEqual({ line: "cyclical", from: { kind: "link" } })
  })

  it("takes one end's device line, either end", () => {
    expect(
      resolveLine("straight", undefined, end(A, { line: "bendy" }), end(B))
    ).toEqual({ line: "bendy", from: { kind: "device", id: A } })
    expect(
      resolveLine("straight", undefined, end(A), end(B, { line: "elbow" }))
    ).toEqual({ line: "elbow", from: { kind: "device", id: B } })
  })

  it("takes two equal device lines as that line", () => {
    const r = resolveLine(
      "straight",
      undefined,
      end(A, { line: "elbow" }),
      end(B, { line: "elbow" })
    )
    expect(r.line).toBe("elbow")
    expect(r.from.kind).toBe("device")
  })

  it("lets the source end win two different device lines", () => {
    expect(
      resolveLine(
        "straight",
        undefined,
        end(A, { line: "bendy" }),
        end(B, { line: "elbow" })
      )
    ).toEqual({ line: "bendy", from: { kind: "device", id: A } })
    expect(
      resolveLine(
        "straight",
        undefined,
        end(B, { line: "elbow" }),
        end(A, { line: "bendy" })
      )
    ).toEqual({ line: "elbow", from: { kind: "device", id: B } })
  })

  it("takes one end's band line, either end", () => {
    const band = { id: "leaf", line: "bendy" as const }
    expect(
      resolveLine("elbow", undefined, end(A, { band }), end(B))
    ).toEqual({ line: "bendy", from: { kind: "band", id: "leaf" } })
    expect(
      resolveLine("elbow", undefined, end(A), end(B, { band }))
    ).toEqual({ line: "bendy", from: { kind: "band", id: "leaf" } })
  })

  it("takes two equal band lines as that line, and lets A win a tie", () => {
    const same = resolveLine(
      "straight",
      undefined,
      end(A, { band: { id: "r1", line: "elbow" } }),
      end(B, { band: { id: "r2", line: "elbow" } })
    )
    expect(same.line).toBe("elbow")
    expect(
      resolveLine(
        "straight",
        undefined,
        end(A, { band: { id: "spine", line: "cyclical" } }),
        end(B, { band: { id: "leaf", line: "bendy" } })
      )
    ).toEqual({ line: "cyclical", from: { kind: "band", id: "spine" } })
  })

  it("puts a device line on one end over a band line on the other", () => {
    expect(
      resolveLine(
        "straight",
        undefined,
        end(A, { band: { id: "spine", line: "cyclical" } }),
        end(B, { line: "elbow" })
      )
    ).toEqual({ line: "elbow", from: { kind: "device", id: B } })
    // And over its own band's.
    expect(
      resolveLine(
        "straight",
        undefined,
        end(A, { line: "bendy", band: { id: "spine", line: "elbow" } }),
        end(B)
      )
    ).toEqual({ line: "bendy", from: { kind: "device", id: A } })
  })
})

describe("lineResolver", () => {
  const pair = `${A}|${B}`

  it("reads the link, the devices and the bands the cards stand in", () => {
    const of = lineResolver({
      view: "straight",
      links: {},
      nodes: { [B]: "elbow" },
      bands: { leaf: "bendy" },
      bandOf: new Map([[`dev:${A}`, "leaf"]]),
    })
    expect(of(`dev:${A}`, `dev:${B}`, A, B, pair)).toEqual({
      line: "elbow",
      from: { kind: "device", id: B },
    })
    const bandOnly = lineResolver({
      view: "straight",
      bands: { leaf: "bendy" },
      bandOf: new Map([[`dev:${A}`, "leaf"]]),
    })
    expect(bandOnly(`dev:${A}`, `dev:${B}`, A, B, pair)).toEqual({
      line: "bendy",
      from: { kind: "band", id: "leaf" },
    })
  })

  it("is the link's line or the view's with nothing else set", () => {
    const of = lineResolver({
      view: "bendy",
      links: { [pair]: { line: "elbow" } },
    })
    expect(of("x", "y", A, B, pair).line).toBe("elbow")
    expect(of("x", "y", A, B, "other").line).toBe("bendy")
  })
})

describe("bandOfCards", () => {
  const rows = [
    { id: "spine", x: 0, y: 0, w: 1000, h: 200 },
    { id: "leaf", x: 0, y: 300, w: 1000, h: 200 },
    // A smaller row inside the leaf row: the tighter one holds its cards.
    { id: "inner", x: 600, y: 320, w: 300, h: 160 },
  ]
  const positions = {
    "dev:s": [100, 100] as [number, number],
    "dev:l": [100, 400] as [number, number],
    "dev:i": [700, 400] as [number, number],
    "dev:out": [100, 2000] as [number, number],
  }

  it("puts each card in the row holding its centre, where it sets a line", () => {
    const of = bandOfCards(rows, { leaf: "elbow", inner: "bendy" }, positions)
    expect(Object.fromEntries(of)).toEqual({
      "dev:l": "leaf",
      "dev:i": "inner",
    })
  })

  it("is empty when no band sets a line", () => {
    expect(bandOfCards(rows, {}, positions).size).toBe(0)
    expect(bandOfCards(rows, undefined, positions).size).toBe(0)
    expect(bandOfCards(undefined, { leaf: "elbow" }, positions).size).toBe(0)
  })
})

describe("reading saved lines", () => {
  it("keeps only the four line types", () => {
    expect(["straight", "elbow", "bendy", "cyclical"].map(lineTypeOf)).toEqual(
      ["straight", "elbow", "bendy", "cyclical"]
    )
    expect(lineTypeOf("default")).toBeUndefined()
    expect(lineTypeOf(1)).toBeUndefined()
    expect(
      nodeLines({
        [A]: { line: "elbow" },
        [B]: { line: "curved" },
        c: {},
      })
    ).toEqual({ [A]: "elbow" })
  })
})
