import { describe, expect, it } from "vitest"

import {
  collapseContext,
  diffRows,
  gapLabel,
  linesOf,
  parseHunks,
  sideBySide,
} from "./diff"

// What the server's difflib.unified_diff(lineterm="") writes: 3 lines of
// context, headers first.
const OLD = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`)
const NEW = [...OLD]
NEW[5] = "line 6 changed" // replace line 6
NEW.splice(9, 0, "inserted") // insert before old line 10
const NEW_TEXT = NEW.join("\n") + "\n"

const DIFF = [
  "--- pushed 2026-11-01 10:00",
  "+++ rendered now",
  "@@ -3,10 +3,11 @@",
  " line 3",
  " line 4",
  " line 5",
  "-line 6",
  "+line 6 changed",
  " line 7",
  " line 8",
  " line 9",
  "+inserted",
  " line 10",
  " line 11",
  " line 12",
].join("\n")

describe("parseHunks", () => {
  it("numbers both sides and drops the file headers", () => {
    const [h] = parseHunks(DIFF)
    expect(h).toMatchObject({
      oldStart: 3,
      oldLines: 10,
      newStart: 3,
      newLines: 11,
    })
    expect(h.rows[3]).toEqual({
      kind: "del",
      text: "line 6",
      old: 6,
      new: null,
    })
    expect(h.rows[4]).toEqual({
      kind: "add",
      text: "line 6 changed",
      old: null,
      new: 6,
    })
    expect(h.rows[8]).toEqual({
      kind: "add",
      text: "inserted",
      old: null,
      new: 10,
    })
    expect(h.rows[9]).toEqual({
      kind: "context",
      text: "line 10",
      old: 10,
      new: 11,
    })
  })

  it("treats a removed '--' line inside a hunk as a removal, not a header", () => {
    const [h] = parseHunks("@@ -1,2 +1 @@\n a\n---\n")
    expect(h.rows).toEqual([
      { kind: "context", text: "a", old: 1, new: 1 },
      { kind: "del", text: "--", old: 2, new: null },
    ])
  })
})

describe("diffRows", () => {
  it("fills the unchanged lines around the hunks from the new text", () => {
    const rows = diffRows(DIFF, NEW_TEXT)
    expect(rows).toHaveLength(14)
    expect(rows[0]).toEqual({ kind: "context", text: "line 1", old: 1, new: 1 })
    expect(rows[1]).toEqual({ kind: "context", text: "line 2", old: 2, new: 2 })
    expect(rows[rows.length - 1]).toEqual({
      kind: "context",
      text: "line 12",
      old: 12,
      new: 13,
    })
  })

  it("leaves gaps where the text is not known", () => {
    const rows = diffRows(DIFF)
    expect(rows[0]).toEqual({ kind: "gap", hidden: 2 })
    expect(rows).toHaveLength(13)
  })

  it("continues after the last hunk", () => {
    const diff = "@@ -1,2 +1,2 @@\n-a\n+A\n b"
    const rows = diffRows(diff, "A\nb\nc\nd\n")
    expect(rows.slice(-2)).toEqual([
      { kind: "context", text: "c", old: 3, new: 3 },
      { kind: "context", text: "d", old: 4, new: 4 },
    ])
  })

  it("handles a hunk that only adds to an empty side", () => {
    const rows = diffRows("@@ -0,0 +1,2 @@\n+a\n+b", "a\nb\n")
    expect(rows).toEqual([
      { kind: "add", text: "a", old: null, new: 1 },
      { kind: "add", text: "b", old: null, new: 2 },
    ])
  })
})

describe("collapseContext", () => {
  it("keeps three lines either side of a change and folds the rest", () => {
    const text = Array.from({ length: 20 }, (_, i) => `l${i + 1}`)
    text[9] = "L10"
    const diff = "@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+L10\n l11\n l12\n l13"
    const rows = collapseContext(diffRows(diff, text.join("\n")), 3)
    expect(rows[0]).toEqual({ kind: "gap", hidden: 6 })
    expect(
      rows.slice(1, -1).map((r) => (r.kind === "gap" ? "gap" : r.text))
    ).toEqual(["l7", "l8", "l9", "l10", "L10", "l11", "l12", "l13"])
    expect(rows[rows.length - 1]).toEqual({ kind: "gap", hidden: 7 })
  })

  it("merges an existing gap with the hidden lines next to it", () => {
    const rows = collapseContext(
      [
        { kind: "gap", hidden: 4 },
        { kind: "context", text: "a", old: 5, new: 5 },
        { kind: "context", text: "b", old: 6, new: 6 },
        { kind: "add", text: "c", old: null, new: 7 },
      ],
      1
    )
    expect(rows).toEqual([
      { kind: "gap", hidden: 5 },
      { kind: "context", text: "b", old: 6, new: 6 },
      { kind: "add", text: "c", old: null, new: 7 },
    ])
  })

  it("keeps a run of context shorter than twice the window whole", () => {
    const rows = diffRows("@@ -1,4 +1,4 @@\n-a\n+A\n b\n-c\n+C", "A\nb\nC\n")
    expect(collapseContext(rows, 3).some((r) => r.kind === "gap")).toBe(false)
  })
})

describe("sideBySide", () => {
  it("pairs removals with the additions that follow them", () => {
    const pairs = sideBySide(diffRows(DIFF))
    const changed = pairs.filter(
      (p) => p.kind === "pair" && p.left?.kind !== "context"
    )
    expect(changed).toEqual([
      {
        kind: "pair",
        left: { kind: "del", text: "line 6", old: 6, new: null },
        right: { kind: "add", text: "line 6 changed", old: null, new: 6 },
      },
      {
        kind: "pair",
        left: null,
        right: { kind: "add", text: "inserted", old: null, new: 10 },
      },
    ])
    expect(pairs[0]).toEqual({ kind: "gap", hidden: 2 })
  })

  it("leaves the right side empty for extra removals", () => {
    const pairs = sideBySide(diffRows("@@ -1,2 +1 @@\n-a\n-b\n+B"))
    expect(pairs).toEqual([
      {
        kind: "pair",
        left: { kind: "del", text: "a", old: 1, new: null },
        right: { kind: "add", text: "B", old: null, new: 1 },
      },
      {
        kind: "pair",
        left: { kind: "del", text: "b", old: 2, new: null },
        right: null,
      },
    ])
  })
})

describe("helpers", () => {
  it("counts lines the way the server does", () => {
    expect(linesOf("a\nb\n")).toEqual(["a", "b"])
    expect(linesOf("a\nb")).toEqual(["a", "b"])
    expect(linesOf("")).toEqual([])
  })

  it("labels gaps with one ellipsis character", () => {
    expect(gapLabel(1)).toBe("… 1 unchanged line")
    expect(gapLabel(4)).toBe("… 4 unchanged lines")
  })
})
