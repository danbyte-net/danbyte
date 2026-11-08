// @vitest-environment jsdom
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CodeEditor } from "@/components/code-editor"
import { Field } from "@/components/forms/field"
import { IconTip } from "@/components/icon-tip"
import { CellSelect } from "@/components/routing/form-bits"
import { PopoverField } from "@/components/topology/filters-popover"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { NoFieldControl } from "@/components/ui/field-control"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { deviceTypeLabel } from "@/lib/device-type-label"

// Every control has an accessible name (#461). An axe scan found select
// triggers, inputs and icon buttons that a screen reader announced without
// one: the label was on screen but not tied to the control. Two guards:
// a source sweep for the patterns that produced them, and renders of the
// shared pieces that now carry the name.

afterEach(cleanup)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const SRC = join(__dirname, "..")

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) sources(path, out)
    else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx"))
      out.push(path)
  }
  return out
}

/** End of the JSX opening tag that starts at `i` (skips `{…}` attributes). */
function tagEnd(src: string, i: number): number {
  let depth = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === ">" && depth === 0) return j
  }
  return src.length
}

/** Whether `i` sits inside an element that names the control within it. */
function insideNamer(before: string): boolean {
  const namers = [
    "Field",
    "PopoverField",
    "RailPick",
    "RailFilter",
    "label",
    "IconTip",
  ]
  return namers.some((n) => {
    const opens = before.match(new RegExp(`<${n}\\b`, "g"))?.length ?? 0
    const closes = before.match(new RegExp(`</${n}>`, "g"))?.length ?? 0
    return opens > closes
  })
}

const NAMED = /aria-label|aria-labelledby|\bid=|\{\.\.\./

/** Wrappers whose control is named by whoever renders them. */
const NAMED_BY_CALLER = new Set([
  // FormCombobox: inside its own Field.
  "components/forms/combobox.tsx",
  // FilterSelect / AnySelect: only ever rendered in a PopoverField.
  "components/topology/filters-popover.tsx",
  "components/topology/logical-view.tsx",
])

describe("control names: source sweep (#461)", () => {
  const files = sources(SRC).filter(
    (f) => !relative(SRC, f).startsWith("components/ui/")
  )

  it("names every select and combobox trigger", () => {
    const misses: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      if (NAMED_BY_CALLER.has(rel)) continue
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(
        /<(SelectTrigger|Combobox|MultiCombobox)\b/g
      )) {
        const at = m.index
        const tag = src.slice(at, tagEnd(src, at))
        if (NAMED.test(tag)) continue
        const before = src.slice(0, at)
        if (insideNamer(before)) continue
        misses.push(`${rel}:${before.split("\n").length} <${m[1]}>`)
      }
    }
    expect(misses).toEqual([])
  })

  it("names every icon-only button", () => {
    const misses: string[] = []
    for (const file of files) {
      const rel = relative(SRC, file)
      const src = readFileSync(file, "utf8")
      for (const m of src.matchAll(/<Button\b/g)) {
        const at = m.index
        const end = tagEnd(src, at)
        const tag = src.slice(at, end)
        if (!/size="icon/.test(tag)) continue
        // title= names it too; the row-actions pattern still uses it.
        if (/aria-label|aria-labelledby|title=|\{\.\.\./.test(tag)) continue
        if (tag.endsWith("/")) continue
        const body = src.slice(end + 1, src.indexOf("</Button>", end))
        if (/sr-only|aria-label/.test(body)) continue
        const text = body
          .replace(/<[^>]*>/g, "")
          .replace(/\{[^}]*\}/g, "")
          .trim()
        if (text) continue
        const before = src.slice(0, at)
        if (insideNamer(before)) continue
        misses.push(`${rel}:${before.split("\n").length}`)
      }
    }
    expect(misses).toEqual([])
  })
})

describe("control names: shared pieces (#461)", () => {
  it("a popover caption names the control under it", () => {
    render(
      <PopoverField label="Status">
        <Combobox value={null} onChange={() => {}} options={[]} />
      </PopoverField>
    )
    expect(screen.getByRole("combobox", { name: /^Status/ })).toBeTruthy()
  })

  it("a grouped popover caption names the group, not a control", () => {
    render(
      <PopoverField label="Labels" group>
        <Input aria-label="Name" />
        <Input aria-label="Role" />
      </PopoverField>
    )
    expect(screen.getByRole("group", { name: "Labels" })).toBeTruthy()
    expect(screen.getByRole("textbox", { name: "Name" }).id).toBe("")
  })

  it("a select trigger outside a Field takes its aria-label", () => {
    render(
      <Select value="a">
        <SelectTrigger aria-label="Status">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="a">Active</SelectItem>
        </SelectContent>
      </Select>
    )
    expect(screen.getByRole("combobox", { name: "Status" })).toBeTruthy()
  })

  it("a routing cell select is named by its column", () => {
    render(
      <CellSelect
        aria-label="Action"
        value="permit"
        onChange={() => {}}
        options={[{ value: "permit", label: "permit" }]}
      />
    )
    expect(screen.getByRole("combobox", { name: "Action" })).toBeTruthy()
  })

  it("an icon button wrapped in IconTip is named by the tip", () => {
    render(
      <IconTip label="Delete">
        <Button size="icon">
          <svg aria-hidden />
        </Button>
      </IconTip>
    )
    expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy()
  })

  it("a unit select beside a Field's input keeps off the field's id", () => {
    render(
      <Field label="Size">
        <Input />
        <NoFieldControl>
          <Select value="GB">
            <SelectTrigger aria-label="Unit">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="GB">GB</SelectItem>
            </SelectContent>
          </Select>
        </NoFieldControl>
      </Field>
    )
    const input = screen.getByRole("textbox", { name: "Size" })
    const unit = screen.getByRole("combobox", { name: "Unit" })
    expect(unit.id).not.toBe(input.id)
  })

  it("a code editor in a Field is named by the label", () => {
    const { container } = render(
      <Field label="Template (Jinja2)">
        <CodeEditor value="" onChange={() => {}} />
      </Field>
    )
    const content = container.querySelector(".cm-content")
    expect(content).not.toBeNull()
    const labelId = content!.getAttribute("aria-labelledby")
    expect(document.getElementById(labelId!)?.textContent).toBe(
      "Template (Jinja2)"
    )
  })

  it("a device type with no name still links with text", () => {
    expect(deviceTypeLabel({ name: "", model: "" })).toBe("Unnamed device type")
    expect(deviceTypeLabel({ name: " ", model: "SR650" })).toBe("SR650")
    expect(deviceTypeLabel({ name: "SR650 V3" })).toBe("SR650 V3")
  })
})
