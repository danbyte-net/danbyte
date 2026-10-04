// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { TopologyLinkOverride } from "@/lib/api"
import { emptyDocument, historyReducer, initHistory } from "../view-document"
import { LineTabs, LinkLineRow, linkOverride } from "./line-tabs"

// A link's own line in its panel: Default follows the view, a line type
// pins it, and an arc can be turned over. Each change is one undoable edit
// of the view's `links`, keyed by the sorted device pair.

afterEach(cleanup)

const KEY =
  "a0000000-0000-4000-8000-000000000001|b0000000-0000-4000-8000-000000000002"

describe("LineTabs", () => {
  it("names each line type and reports the one picked", () => {
    const onChange = vi.fn()
    render(<LineTabs value="straight" onChange={onChange} />)
    for (const name of ["Straight", "Elbow", "Bendy", "Cyclical"])
      expect(screen.getByRole("button", { name })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Default" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Cyclical" }))
    expect(onChange).toHaveBeenCalledWith("cyclical")
  })
})

describe("linkOverride", () => {
  it("keeps only what is set, and nothing is no override", () => {
    expect(linkOverride({ line: "elbow" })).toEqual({ line: "elbow" })
    expect(linkOverride({ line: undefined, flip: 1 })).toEqual({ flip: 1 })
    expect(linkOverride({ line: undefined })).toBeNull()
    expect(linkOverride({})).toBeNull()
  })
})

describe("LinkLineRow", () => {
  /** The row wired to a view document, as the page wires it. */
  function wired(
    viewLine: "straight" | "cyclical",
    arc?: 1 | -1,
    start: TopologyLinkOverride | null = null
  ) {
    let h = initHistory(
      emptyDocument(start ? { links: { [KEY]: start } } : {}),
      "default"
    )
    const edit = (value: TopologyLinkOverride) => {
      h = historyReducer(h, {
        kind: "do",
        action: { type: "setLink", key: KEY, value: linkOverride(value) },
      })
      view.rerender(row())
    }
    const row = () => (
      <LinkLineRow
        link={{ pairKey: KEY, ...(arc ? { arc } : {}) }}
        override={h.present.links[KEY]}
        viewLine={viewLine}
        onChange={edit}
      />
    )
    const view = render(row())
    return { history: () => h }
  }

  const current = () =>
    screen
      .getAllByRole("button")
      .find((b) => b.getAttribute("aria-current") === "page")?.textContent

  it("follows the view by default, and pins a line type as one undo step", () => {
    const { history } = wired("straight")
    expect(current()).toBe("Default")
    // No arc to turn over on a straight line.
    expect(screen.queryByRole("button", { name: "Flip the arc" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Elbow" }))
    expect(history().present.links[KEY]).toEqual({ line: "elbow" })
    expect(current()).toBe("Elbow")
    fireEvent.click(screen.getByRole("button", { name: "Default" }))
    // Back to the view's line: the key is gone, not stored empty.
    expect(KEY in history().present.links).toBe(false)
    expect(history().past).toHaveLength(2)
    const undone = historyReducer(history(), { kind: "undo" })
    expect(undone.present.links[KEY]).toEqual({ line: "elbow" })
  })

  it("turns an arc over, from the side it is drawn on", () => {
    const { history } = wired("cyclical", -1)
    fireEvent.click(screen.getByRole("button", { name: "Flip the arc" }))
    expect(history().present.links[KEY]).toEqual({ flip: 1 })
    fireEvent.click(screen.getByRole("button", { name: "Flip the arc" }))
    expect(history().present.links[KEY]).toEqual({ flip: -1 })
  })

  it("offers the flip for a link's own Cyclical line, and keeps it with the line", () => {
    const { history } = wired("straight", undefined, { line: "cyclical" })
    expect(current()).toBe("Cyclical")
    fireEvent.click(screen.getByRole("button", { name: "Flip the arc" }))
    expect(history().present.links[KEY]).toEqual({
      line: "cyclical",
      flip: 1,
    })
  })

  it("has no flip where the view's Cyclical draws the link bendy", () => {
    wired("cyclical")
    expect(screen.queryByRole("button", { name: "Flip the arc" })).toBeNull()
  })
})
