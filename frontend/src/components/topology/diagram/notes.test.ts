import { describe, expect, it } from "vitest"

import type { TopologyViewNote } from "@/lib/api"
import {
  NEW_NOTE_TEXT,
  NOTE_TEXT_MAX,
  cleanNoteText,
  moveNotes,
  newNote,
  patchNote,
  readNotes,
  removeNotes,
} from "./notes"
import { viewNotes } from "./to-document"

const text = (id: string, x = 0, y = 0): TopologyViewNote => ({
  id,
  kind: "text",
  x,
  y,
  text: id,
})

describe("cleanNoteText", () => {
  it("normalises line ends, trims and caps", () => {
    expect(cleanNoteText("  MPLS\r\nL3VPN \n")).toBe("MPLS\nL3VPN")
    expect(cleanNoteText("x".repeat(300))).toHaveLength(NOTE_TEXT_MAX)
    expect(cleanNoteText(" \n ")).toBe("")
  })
})

describe("readNotes", () => {
  it("keeps what can be drawn, each id once", () => {
    const good = text("a", 1, 2)
    const icon: TopologyViewNote = {
      id: "b",
      kind: "icon",
      icon: "cloud",
      x: 0,
      y: 0,
    }
    expect(
      readNotes([
        good,
        icon,
        { ...good, text: "again" },
        { id: "c", kind: "text", x: Number.NaN, y: 0 },
        { id: "d", kind: "text", x: "1", y: 0 },
        { id: "e", kind: "icon", icon: "rocket", x: 0, y: 0 },
        { id: "f", kind: "line", x: 0, y: 0 },
        { kind: "text", x: 0, y: 0 },
        "nope",
      ])
    ).toEqual([good, icon])
    expect(readNotes(undefined)).toEqual([])
    expect(readNotes({})).toEqual([])
  })
})

describe("newNote", () => {
  it("makes a text note saying Text, or an icon without a caption", () => {
    expect(newNote([], "n1", { kind: "text" }, { x: 10.4, y: 20.6 })).toEqual({
      id: "n1",
      kind: "text",
      x: 10,
      y: 21,
      size: "m",
      text: NEW_NOTE_TEXT,
    })
    expect(
      newNote([], "n2", { kind: "icon", icon: "globe" }, { x: 0, y: 0 })
    ).toEqual({ id: "n2", kind: "icon", icon: "globe", x: 0, y: 0, size: "m" })
  })

  it("steps down clear of a note on its spot, with an id of its own", () => {
    const have = [text("n1", 100, 100), text("n1~2", 100, 132)]
    const n = newNote(have, "n1", { kind: "text" }, { x: 105, y: 110 })
    expect(n.id).toBe("n1~3")
    expect([n.x, n.y]).toEqual([105, 174])
    // Far enough away, it lands where asked.
    expect(newNote(have, "z", { kind: "text" }, { x: 400, y: 100 }).y).toBe(100)
  })
})

describe("patchNote, removeNotes, moveNotes", () => {
  const notes = [
    text("a"),
    { ...text("b"), kind: "icon", icon: "cloud" } as TopologyViewNote,
  ]

  it("patches one note; undefined removes a key", () => {
    const next = patchNote(notes, "a", { size: "l", outline: true })
    expect(next[0]).toMatchObject({ size: "l", outline: true })
    expect(next[1]).toBe(notes[1])
    const off = patchNote(next, "a", { outline: undefined })
    expect("outline" in off[0]).toBe(false)
    const bare = patchNote(notes, "b", { text: undefined })
    expect("text" in bare[1]).toBe(false)
  })

  it("hands the same list back when nothing changed", () => {
    expect(patchNote(notes, "a", { text: "a" })).toBe(notes)
    expect(patchNote(notes, "zz", { text: "x" })).toBe(notes)
    expect(patchNote(notes, "a", { outline: undefined })).toBe(notes)
    expect(removeNotes(notes, ["zz"])).toBe(notes)
  })

  it("removes notes by id", () => {
    expect(removeNotes(notes, ["a"]).map((n) => n.id)).toEqual(["b"])
  })

  it("moves notes to rounded centres, or reports none moved", () => {
    const at = new Map([["b", { x: 10.6, y: -3.2 }]])
    const next = moveNotes(notes, at)!
    expect([next[1].x, next[1].y]).toEqual([11, -3])
    expect(next[0]).toBe(notes[0])
    expect(moveNotes(notes, new Map([["a", { x: 0.2, y: 0 }]]))).toBeNull()
    expect(moveNotes(notes, new Map())).toBeNull()
  })
})

describe("viewNotes", () => {
  it("carries size and outline, medium left out", () => {
    const out = viewNotes([
      { ...text("a", 5, 6), size: "l", outline: true },
      { ...text("b"), size: "m" },
      { id: "c", kind: "icon", icon: "building", x: 1, y: 2, size: "s" },
    ])
    expect(out).toEqual([
      { id: "note:a", x: 5, y: 6, text: "a", size: "l", outline: true },
      { id: "note:b", x: 0, y: 0, text: "b" },
      { id: "note:c", x: 1, y: 2, icon: "building", size: "s" },
    ])
  })

  it("keeps the notes whose centre is in the area, and none that are empty", () => {
    const area = { x: 0, y: 0, w: 100, h: 100 }
    const out = viewNotes(
      [
        text("in", 50, 50),
        text("out", 150, 50),
        { id: "empty", kind: "text", x: 10, y: 10, text: "" },
      ],
      area
    )
    expect(out.map((n) => n.id)).toEqual(["note:in"])
  })
})
