// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TopologyViewSaved } from "@/lib/api"
import { NO_TOPO_HIDDEN } from "./hidden"
import {
  HISTORY_LIMIT,
  docFromView,
  docReducer,
  emptyDocument,
  historyReducer,
  initHistory,
  readDefaultMap,
  storedDefaultMap,
  toViewState,
  useDocumentKeys,
  useViewDocument,
} from "./view-document"
import type { DocAction, DocHistory, ViewDocument } from "./view-document"

afterEach(cleanup)

const styleOf = (raw: unknown) =>
  ["stencil", "hierarchy", "flat", "logical"].includes(raw as string)
    ? (raw as string)
    : "stencil"

const view = (state: Record<string, unknown>): TopologyViewSaved => ({
  id: "v1",
  numid: 1,
  name: "core",
  state,
  created_at: "",
  updated_at: "2026-09-01T00:00:00Z",
})

const zone = (id: string) => ({
  id,
  label: id,
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  color: "#64748b",
})

const run = (doc: ViewDocument, ...actions: DocAction[]) =>
  actions.reduce(docReducer, doc)

const act1 = (h: DocHistory, action: DocAction, step?: string) =>
  historyReducer(h, { kind: "do", action, step })

const move = (x: number): DocAction => ({
  type: "setPositions",
  style: "stencil",
  positions: { "dev:a": [x, 0] },
})

describe("docFromView / toViewState", () => {
  it("splits the device set out of the filters and keeps unknown keys", () => {
    const d = docFromView(
      view({
        filters: { viewStyle: "flat", site: "s1", devices: ["a", "b"] },
        positions_by_style: { flat: { "dev:a": [1, 2] } },
        zones_by_style: { flat: [zone("z1")], bogus: [zone("z2")] },
        hidden: ["dev:c"],
        links: { "a|b": { line: "bendy" } },
        future_key: { kept: true },
      }),
      styleOf
    )
    expect(d.devices).toEqual(["a", "b"])
    expect(d.filters).toEqual({ viewStyle: "flat", site: "s1" })
    expect(d.positions).toEqual({ flat: { "dev:a": [1, 2] } })
    expect(Object.keys(d.zones)).toEqual(["flat"])
    expect(d.hidden.devices).toEqual(["dev:c"])
    expect(d.links).toEqual({ "a|b": { line: "bendy" } })
    expect(d.extra).toEqual({ future_key: { kept: true } })
  })

  it("reads a pre-split view's single arrangement under its style", () => {
    const d = docFromView(
      view({ filters: { viewStyle: "hierarchy" }, positions: { x: [1, 1] } }),
      styleOf
    )
    expect(d.positions).toEqual({ hierarchy: { x: [1, 1] } })
  })

  it("tolerates a view with no state at all", () => {
    const d = docFromView(view(null as never), styleOf)
    expect(d).toEqual(emptyDocument())
  })

  it("writes the URL's settings over the saved ones", () => {
    const d = emptyDocument({
      filters: { colorMode: "type", diagram: { mode: "simple" } as never },
      positions: { stencil: { "dev:a": [1, 2] } },
      notes: [{ id: "n1", kind: "text", x: 0, y: 0, text: "WAN" }],
      extra: { future_key: 1 },
    })
    const s = toViewState(d, {
      filters: { colorMode: "speed", lag: "off" },
      style: "stencil",
    })
    expect(s.filters).toEqual({
      colorMode: "speed",
      lag: "off",
      diagram: { mode: "simple" },
    })
    expect(s.positions).toEqual({ "dev:a": [1, 2] })
    expect(s.positions_by_style).toEqual({ stencil: { "dev:a": [1, 2] } })
    expect(s.notes).toHaveLength(1)
    expect((s as Record<string, unknown>).future_key).toBe(1)
    // Empty overrides stay out of the payload.
    expect("links" in s).toBe(false)
    expect("nodes" in s).toBe(false)
  })

  it("saves the device set the page passes, or none", () => {
    const d = emptyDocument({ devices: ["a"], filters: { devices: ["x"] } })
    expect(toViewState(d).filters?.devices).toEqual(["a"])
    expect(toViewState(d, { devices: ["b"] }).filters?.devices).toEqual(["b"])
    expect("devices" in toViewState(d, { devices: null }).filters!).toBe(false)
  })

  it("gives the logical view an empty legacy arrangement", () => {
    const d = emptyDocument({ positions: { stencil: { a: [0, 0] } } })
    expect(toViewState(d, { style: "logical" }).positions).toEqual({})
  })
})

describe("storedDefaultMap / readDefaultMap", () => {
  it("keeps everything a view saves, without a device set", () => {
    const d = emptyDocument({
      positions: { diagram: { "dev:a": [1, 2] }, stencil: { "dev:a": [3, 4] } },
      zones: { diagram: [zone("b1")] },
      filters: { diagram: { mode: "simple", line: "bendy" } as never },
      links: { "a|b": { line: "cyclical", flip: -1 } },
      nodes: { a: { face: "photo" } },
      notes: [{ id: "n1", kind: "text", x: 0, y: 0, text: "WAN" }],
      hidden: { ...NO_TOPO_HIDDEN, devices: ["dev:c"] },
      devices: ["a"],
      extra: { future_key: 1 },
    })
    const back = readDefaultMap(storedDefaultMap(d), styleOf)
    expect(back).toEqual({ ...d, devices: null, extra: {} })
  })

  it("reads nothing from an absent or unreadable copy", () => {
    expect(readDefaultMap(null, styleOf)).toBeNull()
    expect(readDefaultMap("", styleOf)).toBeNull()
    expect(readDefaultMap("{not json", styleOf)).toBeNull()
    expect(readDefaultMap("[1,2]", styleOf)).toBeNull()
  })
})

describe("docReducer: positions keep snapshot semantics", () => {
  const base = emptyDocument({
    positions: {
      stencil: { "dev:a": [0, 0], "dev:b": [5, 5], "dev:x": [9, 9] },
      flat: { "dev:a": [1, 1] },
    },
  })

  it("replaces the style with the snapshot, keeping only unseen cards", () => {
    const next = run(base, {
      type: "setPositions",
      style: "stencil",
      positions: { "dev:a": [3, 3] },
      // b is on the map (hidden, say) so its entry goes; x is a card this
      // user cannot see, so it stays.
      seen: ["dev:a", "dev:b"],
    })
    expect(next.positions.stencil).toEqual({
      "dev:a": [3, 3],
      "dev:x": [9, 9],
    })
    expect(next.positions.flat).toBe(base.positions.flat)
  })

  it("replaces outright without a seen list", () => {
    const next = run(base, {
      type: "setPositions",
      style: "stencil",
      positions: { "dev:a": [3, 3] },
    })
    expect(next.positions.stencil).toEqual({ "dev:a": [3, 3] })
  })

  it("Re-layout drops the style but keeps unseen cards", () => {
    const relaid = run(base, {
      type: "setPositions",
      style: "stencil",
      positions: null,
      seen: ["dev:a", "dev:b"],
    })
    expect(relaid.positions.stencil).toEqual({ "dev:x": [9, 9] })
    const all = run(base, {
      type: "setPositions",
      style: "stencil",
      positions: null,
      seen: ["dev:a", "dev:b", "dev:x"],
    })
    expect("stencil" in all.positions).toBe(false)
  })

  it("an unchanged snapshot is not a change", () => {
    const next = run(base, {
      type: "setPositions",
      style: "flat",
      positions: { "dev:a": [1, 1] },
    })
    expect(next).toBe(base)
  })

  it("clearPositions drops every style", () => {
    expect(run(base, { type: "clearPositions" }).positions).toEqual({})
    const empty = emptyDocument()
    expect(run(empty, { type: "clearPositions" })).toBe(empty)
  })
})

describe("docReducer: device set", () => {
  it("adds devices and pins them in one step", () => {
    const d = run(emptyDocument({ devices: ["a"] }), {
      type: "addDevices",
      ids: ["a", "b"],
      style: "diagram",
      place: { "dev:b": [10, 20] },
    })
    expect(d.devices).toEqual(["a", "b"])
    expect(d.positions.diagram).toEqual({ "dev:b": [10, 20] })
  })

  it("removing a device prunes everything that belonged to it", () => {
    const d = emptyDocument({
      devices: ["a", "b"],
      positions: {
        stencil: { "dev:a": [0, 0], "dev:b": [1, 1] },
        flat: { "dev:a": [0, 0] },
      },
      links: { "a|b": { line: "elbow" }, "b|c": { flip: -1 } },
      nodes: { a: { face: "photo" }, b: { face: "card" } },
      hidden: { ...NO_TOPO_HIDDEN, devices: ["dev:a", "dev:c"] },
    })
    const next = run(d, { type: "removeDevices", ids: ["a"] })
    expect(next.devices).toEqual(["b"])
    expect(next.positions).toEqual({ stencil: { "dev:b": [1, 1] } })
    expect(next.links).toEqual({ "b|c": { flip: -1 } })
    expect(next.nodes).toEqual({ b: { face: "card" } })
    expect(next.hidden.devices).toEqual(["dev:c"])
    expect(run(next, { type: "removeDevices", ids: ["zz"] })).toBe(next)
  })
})

describe("docReducer: the other edits", () => {
  it("sets and clears regions per style", () => {
    const d = run(emptyDocument(), {
      type: "setRegions",
      style: "stencil",
      regions: [zone("z1")],
    })
    expect(d.zones.stencil).toHaveLength(1)
    const cleared = run(d, {
      type: "setRegions",
      style: "stencil",
      regions: [],
    })
    expect("stencil" in cleared.zones).toBe(false)
  })

  it("sets and removes link and card overrides", () => {
    let d = run(emptyDocument(), {
      type: "setLink",
      key: "a|b",
      value: { line: "cyclical", flip: 1 },
    })
    expect(d.links["a|b"]).toEqual({ line: "cyclical", flip: 1 })
    d = run(d, { type: "setLink", key: "a|b", value: null })
    expect(d.links).toEqual({})
    d = run(d, { type: "setNode", id: "a", value: { face: "photo" } })
    expect(d.nodes).toEqual({ a: { face: "photo" } })
    d = run(d, { type: "setNode", id: "a", value: null })
    expect(d.nodes).toEqual({})
  })

  it("merges display settings, an undefined value removing the key", () => {
    const d = run(
      emptyDocument({ filters: { colorMode: "type", lag: "on" } }),
      { type: "setDisplay", patch: { lag: undefined, direction: "TB" } }
    )
    expect(d.filters).toEqual({ colorMode: "type", direction: "TB" })
  })

  it("notes, hidden and replace", () => {
    const note = {
      id: "n",
      kind: "icon" as const,
      x: 1,
      y: 2,
      icon: "cloud" as const,
    }
    let d = run(emptyDocument(), { type: "setNotes", notes: [note] })
    expect(d.notes).toEqual([note])
    const hidden = { ...NO_TOPO_HIDDEN, roles: ["Access"] }
    d = run(d, { type: "setHidden", hidden })
    expect(d.hidden.roles).toEqual(["Access"])
    expect(run(d, { type: "setHidden", hidden: { ...hidden } })).toBe(d)
    const other = emptyDocument({ devices: [] })
    expect(run(d, { type: "replace", doc: other })).toBe(other)
  })
})

describe("historyReducer", () => {
  const start = () => initHistory(emptyDocument(), "view:v1", "t0")

  it("undo and redo walk the steps and stop at either end", () => {
    let h = start()
    expect(historyReducer(h, { kind: "undo" })).toBe(h)
    h = act1(h, move(1))
    h = act1(h, move(2))
    const two = h.present
    h = historyReducer(h, { kind: "undo" })
    expect(h.present.positions.stencil).toEqual({ "dev:a": [1, 0] })
    h = historyReducer(h, { kind: "undo" })
    expect(h.present).toBe(h.saved)
    expect(historyReducer(h, { kind: "undo" })).toBe(h)
    h = historyReducer(h, { kind: "redo" })
    h = historyReducer(h, { kind: "redo" })
    expect(h.present).toBe(two)
    expect(historyReducer(h, { kind: "redo" })).toBe(h)
  })

  it("a new edit clears the redo stack", () => {
    let h = act1(act1(start(), move(1)), move(2))
    h = historyReducer(h, { kind: "undo" })
    expect(h.future).toHaveLength(1)
    h = act1(h, move(7))
    expect(h.future).toHaveLength(0)
  })

  it(`keeps at most ${HISTORY_LIMIT} steps`, () => {
    let h = start()
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) h = act1(h, move(i))
    expect(h.past).toHaveLength(HISTORY_LIMIT)
    for (let i = 0; i < HISTORY_LIMIT + 5; i++)
      h = historyReducer(h, { kind: "undo" })
    // The oldest steps are gone: undo stops 20 moves in, not at the start.
    expect(h.present.positions.stencil).toEqual({ "dev:a": [20, 0] })
    expect(h.future).toHaveLength(HISTORY_LIMIT)
  })

  it("a no-op edit is not a step", () => {
    const h = act1(start(), move(1))
    expect(act1(h, move(1))).toBe(h)
  })

  it("edits sharing a step key coalesce into one step", () => {
    let h = start()
    h = act1(
      h,
      { type: "setRegions", style: "stencil", regions: [zone("z")] },
      "drag#1"
    )
    h = act1(h, move(5), "drag#1")
    expect(h.past).toHaveLength(1)
    h = act1(h, move(6), "drag#2")
    expect(h.past).toHaveLength(2)
    h = historyReducer(h, { kind: "undo" })
    h = historyReducer(h, { kind: "undo" })
    // One undo took back both the zone and the cards of the first drag.
    expect(h.present).toEqual(emptyDocument())
  })

  it("does not coalesce into a step that was undone", () => {
    let h = act1(start(), move(1), "drag#1")
    h = historyReducer(h, { kind: "undo" })
    h = act1(h, move(2), "drag#1")
    expect(h.past).toHaveLength(1)
    expect(h.future).toHaveLength(0)
  })

  it("dirty is 'not the saved document'", () => {
    let h = start()
    const dirty = (x: DocHistory) => x.present !== x.saved
    expect(dirty(h)).toBe(false)
    h = act1(h, move(1))
    expect(dirty(h)).toBe(true)
    h = historyReducer(h, { kind: "undo" })
    expect(dirty(h)).toBe(false)
    h = historyReducer(h, { kind: "redo" })
    h = historyReducer(h, {
      kind: "saved",
      doc: h.present,
      key: "view:v1",
      base: "t1",
    })
    expect(dirty(h)).toBe(false)
    expect(h.base).toBe("t1")
    // The save can still be undone - and that is a change again.
    h = historyReducer(h, { kind: "undo" })
    expect(dirty(h)).toBe(true)
  })

  it("load forgets the history", () => {
    let h = act1(start(), move(1))
    const doc = emptyDocument({ devices: [] })
    h = historyReducer(h, { kind: "load", doc, key: "custom", base: null })
    expect(h).toEqual(initHistory(doc, "custom"))
  })
})

describe("useViewDocument", () => {
  const setup = () =>
    renderHook(() =>
      useViewDocument(() => ({ doc: emptyDocument(), key: "default" }))
    )

  it("one gesture in one handler is one undo step", async () => {
    const { result } = setup()
    act(() => {
      result.current.dispatch(
        { type: "setRegions", style: "stencil", regions: [zone("z")] },
        { coalesce: "drag" }
      )
      result.current.dispatch(move(1), { coalesce: "drag" })
    })
    await act(async () => {
      await Promise.resolve()
      result.current.dispatch(move(2), { coalesce: "drag" })
    })
    expect(result.current.dirty).toBe(true)
    act(() => {
      result.current.undo()
    })
    expect(result.current.doc.positions.stencil).toEqual({ "dev:a": [1, 0] })
    let to: ViewDocument | null = null
    act(() => {
      to = result.current.undo()
    })
    expect(to).toEqual(emptyDocument())
    expect(result.current.dirty).toBe(false)
    expect(result.current.canUndo).toBe(false)
    expect(result.current.canRedo).toBe(true)
  })

  it("markSaved clears dirty at once and keeps the undo stack", () => {
    const { result } = setup()
    act(() => result.current.dispatch(move(1)))
    const saved = result.current.doc
    act(() => {
      result.current.markSaved(saved, "view:new", "t9")
      expect(result.current.dirtyRef.current).toBe(false)
    })
    expect(result.current.dirty).toBe(false)
    expect(result.current.docKey).toBe("view:new")
    expect(result.current.base).toBe("t9")
    expect(result.current.canUndo).toBe(true)
  })

  it("load swaps the map and clears the history", () => {
    const { result } = setup()
    act(() => result.current.dispatch(move(1)))
    act(() => {
      result.current.load(emptyDocument({ devices: ["a"] }), "custom")
      expect(result.current.dirtyRef.current).toBe(false)
    })
    expect(result.current.doc.devices).toEqual(["a"])
    expect(result.current.canUndo).toBe(false)
    expect(result.current.docKey).toBe("custom")
  })
})

describe("useDocumentKeys", () => {
  const press = (init: KeyboardEventInit, target: EventTarget = window) => {
    const e = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ...init,
    })
    target.dispatchEvent(e)
    return e
  }
  const setup = (onSave = () => true) => {
    const h = { onSave: vi.fn(onSave), onUndo: vi.fn(), onRedo: vi.fn() }
    renderHook(() => useDocumentKeys({ enabled: true, ...h }))
    return h
  }

  it("maps the shortcuts", () => {
    const h = setup()
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(true)
    press({ key: "z", metaKey: true })
    press({ key: "Z", ctrlKey: true, shiftKey: true })
    press({ key: "y", ctrlKey: true })
    expect(h.onSave).toHaveBeenCalledTimes(1)
    expect(h.onUndo).toHaveBeenCalledTimes(1)
    expect(h.onRedo).toHaveBeenCalledTimes(2)
  })

  it("leaves Ctrl+S to the browser when there is nothing to save to", () => {
    setup(() => false)
    expect(press({ key: "s", ctrlKey: true }).defaultPrevented).toBe(false)
  })

  it("leaves undo in a text field to the field", () => {
    const h = setup()
    const input = document.createElement("input")
    document.body.append(input)
    press({ key: "z", ctrlKey: true }, input)
    expect(h.onUndo).not.toHaveBeenCalled()
    input.remove()
  })

  it("stays out of open dialogs", () => {
    const h = setup()
    const dlg = document.createElement("div")
    dlg.setAttribute("role", "dialog")
    const input = document.createElement("input")
    dlg.append(input)
    document.body.append(dlg)
    press({ key: "s", ctrlKey: true }, input)
    expect(h.onSave).not.toHaveBeenCalled()
    dlg.remove()
  })
})
