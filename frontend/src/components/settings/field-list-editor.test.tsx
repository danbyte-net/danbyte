// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { FieldListEditor, FieldScopeRow } from "./field-list-editor"
import type { FieldMeta } from "./field-list-editor"

const META: Record<string, FieldMeta> = {
  a: { label: "Alpha", hint: "First" },
  b: { label: "Bravo", hint: "" },
  c: { label: "Charlie", hint: "Third" },
  d: { label: "Delta", hint: "" },
}
const meta = (k: string) => META[k] ?? { label: k, hint: "" }
const AVAILABLE = ["a", "b", "c", "d"]
const GROUPS = [
  { title: "Letters", keys: ["a", "b", "c"] },
  { title: "More", keys: ["d"] },
]

function setup(
  value: string[],
  props: Partial<React.ComponentProps<typeof FieldListEditor>> = {}
) {
  const onChange = vi.fn<(next: string[]) => void>()
  render(
    <FieldListEditor
      value={value}
      onChange={onChange}
      editable
      meta={meta}
      groups={GROUPS}
      available={AVAILABLE}
      empty="Nothing here"
      {...props}
    />
  )
  return onChange
}

afterEach(cleanup)

describe("FieldListEditor", () => {
  it("moves a field up and down", () => {
    const onChange = setup(["a", "b", "c"])
    fireEvent.click(screen.getByLabelText("Move Bravo up"))
    expect(onChange).toHaveBeenLastCalledWith(["b", "a", "c"])
    fireEvent.click(screen.getByLabelText("Move Bravo down"))
    expect(onChange).toHaveBeenLastCalledWith(["a", "c", "b"])
  })

  it("cannot move past either end", () => {
    setup(["a", "b"])
    expect(screen.getByLabelText("Move Alpha up")).toHaveProperty(
      "disabled",
      true
    )
    expect(screen.getByLabelText("Move Bravo down")).toHaveProperty(
      "disabled",
      true
    )
  })

  it("removes a field", () => {
    const onChange = setup(["a", "b"])
    fireEvent.click(screen.getByLabelText("Remove Alpha"))
    expect(onChange).toHaveBeenLastCalledWith(["b"])
  })

  it("offers only what is not listed yet, grouped", () => {
    setup(["a", "c"])
    expect(screen.getByText("Letters")).toBeTruthy()
    const chips = screen
      .getAllByRole("button")
      .map((b) => b.textContent)
      .filter((t) => t && !["Alpha", "Charlie"].includes(t))
    expect(chips).toEqual(["Bravo", "Delta"])
  })

  it("appends an added field by default", () => {
    const onChange = setup(["c", "a"])
    fireEvent.click(screen.getByRole("button", { name: "Bravo" }))
    expect(onChange).toHaveBeenLastCalledWith(["c", "a", "b"])
  })

  it("inserts in canonical order when asked", () => {
    const onChange = setup(["c", "a"], { insert: "canonical" })
    fireEvent.click(screen.getByRole("button", { name: "Bravo" }))
    expect(onChange).toHaveBeenLastCalledWith(["a", "b", "c"])
  })

  it("turns the add chips off at the cap", () => {
    setup(["a", "b"], { max: 2 })
    expect(screen.getByRole("button", { name: "Charlie" })).toHaveProperty(
      "disabled",
      true
    )
  })

  it("draws the empty row for an empty list", () => {
    setup([])
    expect(screen.getByText("Nothing here")).toBeTruthy()
  })

  it("is a read-only preview when not editable", () => {
    setup(["a", "b"], { editable: false })
    expect(screen.getByText("Alpha")).toBeTruthy()
    expect(screen.queryByLabelText("Remove Alpha")).toBeNull()
    expect(screen.queryByText("Letters")).toBeNull()
  })
})

describe("FieldScopeRow", () => {
  it("marks a scope with its own list as Custom", () => {
    const onSelect = vi.fn()
    render(<FieldScopeRow active onSelect={onSelect} label="Core" custom />)
    const row = screen.getByRole("button")
    expect(row.textContent).toBe("CoreCustom")
    expect(row.getAttribute("aria-current")).toBe("true")
    fireEvent.click(row)
    expect(onSelect).toHaveBeenCalled()
  })
})
