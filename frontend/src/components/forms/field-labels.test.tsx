// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { DevicePicker } from "@/components/device-picker"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { CheckList } from "./check-list"
import { FormCheckbox } from "./checkbox"
import { FormCombobox } from "./combobox"
import { FormDate } from "./date"
import { Field } from "./field"
import { FormSelect } from "./select"
import { FormStatusSelect } from "./status-select"
import { FormText } from "./text"
import { FormTextarea } from "./textarea"
import { UnitInput, MEMORY_UNITS } from "./unit-input"

// A form field is named by its visible label (#428): the <label> points at
// the control (click-to-focus, getByLabelText, screen readers), the hint and
// error describe it, and an error marks it invalid. Field wires this once for
// every shared control.

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: vi.fn(async () => ({ count: 0, results: [] })),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}

afterEach(cleanup)

const noop = () => {}

function withQuery(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
}

/** The <label> element whose text is `text`, and the control it points at. */
function labelled(text: string) {
  const label = screen.getByText<HTMLLabelElement>(text, { selector: "label" })
  const id = label.getAttribute("for")
  expect(id).toBeTruthy()
  const control = document.getElementById(id!)
  expect(control).not.toBeNull()
  return { label, control: control! }
}

describe("Field labels name their control (#428)", () => {
  it.each([
    [
      "FormText",
      <FormText key="t" label="Name" value="" onChange={noop} />,
      "INPUT",
    ],
    [
      "FormTextarea",
      <FormTextarea key="a" label="Description" value="" onChange={noop} />,
      "TEXTAREA",
    ],
    [
      "FormSelect",
      <FormSelect
        key="s"
        label="Role"
        value="a"
        onChange={noop}
        options={[{ value: "a", label: "Core" }]}
      />,
      "BUTTON",
    ],
    [
      "FormCombobox",
      <FormCombobox
        key="c"
        label="Device type"
        value={null}
        onChange={noop}
        options={[{ value: "x", label: "C9300" }]}
      />,
      "BUTTON",
    ],
    [
      "FormStatusSelect",
      <FormStatusSelect
        key="st"
        value={null}
        onChange={noop}
        options={[{ id: "a", name: "Active" }]}
      />,
      "BUTTON",
    ],
    [
      "FormDate",
      <FormDate key="d" label="Install date" value="" onChange={noop} />,
      "BUTTON",
    ],
    [
      "Switch in a Field",
      <Field key="sw" label="Enabled">
        <Switch />
      </Field>,
      "BUTTON",
    ],
    [
      "Checkbox in a Field",
      <Field key="cb" label="Primary">
        <Checkbox />
      </Field>,
      "BUTTON",
    ],
    [
      "IdMultiSelect in a Field",
      <Field key="ms" label="Templates">
        <IdMultiSelect options={[]} value={[]} onChange={noop} />
      </Field>,
      "BUTTON",
    ],
  ])("%s: getByLabelText finds it", (_, ui, tag) => {
    render(withQuery(ui))
    const name = ui.props.label ?? "Status"
    const { control } = labelled(name)
    expect(control.tagName).toBe(tag)
    expect(screen.getByLabelText(name)).toBe(control)
    // The accessible name starts with the label text alone - not the (i)
    // or planned-change buttons that sit inside the <label>.
    const ids = control.getAttribute("aria-labelledby")!.split(" ")
    expect(document.getElementById(ids[0])!.textContent).toBe(name)
  })

  it("the label is the input's label, so clicking it reaches the input", () => {
    render(<FormText label="Name" value="" onChange={noop} />)
    const { label, control } = labelled("Name")
    // `label.control` is what a browser focuses on a label click; jsdom
    // resolves it but does not move focus itself.
    expect(label.control).toBe(control)
    const clicked = vi.fn()
    control.addEventListener("click", clicked)
    fireEvent.click(label)
    expect(clicked).toHaveBeenCalled()
  })

  it("clicking the label activates a switch", () => {
    const onChange = vi.fn()
    render(
      <Field label="Enabled">
        <Switch onCheckedChange={onChange} />
      </Field>
    )
    fireEvent.click(labelled("Enabled").label)
    expect(onChange).toHaveBeenCalledWith(true)
  })

  it("a picker trigger is named by the label and keeps its value", () => {
    render(
      <FormCombobox
        label="Device type"
        value="x"
        onChange={noop}
        options={[{ value: "x", label: "C9300" }]}
      />
    )
    const trigger = screen.getByRole("combobox")
    const [labelId, selfId] = trigger
      .getAttribute("aria-labelledby")!
      .split(" ")
    expect(document.getElementById(labelId)!.textContent).toBe("Device type")
    expect(selfId).toBe(trigger.id)
    expect(trigger.textContent).toContain("C9300")
  })

  it("the device picker's trigger is named by its label", async () => {
    render(withQuery(<DevicePicker value={null} onChange={noop} />))
    const { control } = labelled("Device")
    expect(control.getAttribute("role")).toBe("combobox")
    // The advanced-search button keeps its own name.
    expect(
      screen.getByRole("button", { name: "Advanced device search" }).id
    ).not.toBe(control.id)
  })

  it("hint and error describe the control; an error marks it invalid", () => {
    const { rerender } = render(
      <FormText label="Name" hint="optional" value="" onChange={noop} />
    )
    let input = screen.getByLabelText("Name")
    expect(input.getAttribute("aria-invalid")).toBeNull()
    expect(
      document.getElementById(input.getAttribute("aria-describedby")!)!
        .textContent
    ).toBe("optional")

    rerender(
      <FormText
        label="Name"
        hint="optional"
        error="This field is required."
        value=""
        onChange={noop}
      />
    )
    input = screen.getByLabelText("Name")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    const described = input
      .getAttribute("aria-describedby")!
      .split(" ")
      .map((id) => document.getElementById(id)!.textContent)
    expect(described).toEqual(["optional", "This field is required."])
  })

  it("a long hint below the control still describes it", () => {
    const hint = "Leave empty to inherit the value from the parent site."
    render(<FormTextarea label="Notes" hint={hint} value="" onChange={noop} />)
    const area = screen.getByLabelText("Notes")
    expect(
      document.getElementById(area.getAttribute("aria-describedby")!)!
        .textContent
    ).toBe(hint)
  })

  it("an explicit aria-label or id on the control wins", () => {
    render(
      <Field label="Range">
        <Input aria-label="From" />
      </Field>
    )
    const input = screen.getByLabelText("From")
    expect(input.getAttribute("aria-labelledby")).toBeNull()
  })

  it("the unit box beside a number does not take the field's id", () => {
    render(
      <UnitInput
        label="Memory"
        base="MB"
        units={MEMORY_UNITS}
        value="1024"
        onChange={noop}
      />
    )
    const { control } = labelled("Memory")
    expect(control.tagName).toBe("INPUT")
    expect(screen.getByLabelText("Memory unit").tagName).toBe("BUTTON")
    expect(document.querySelectorAll(`[id="${control.id}"]`)).toHaveLength(1)
  })

  it("self-labelled checkboxes inside a Field keep their own label", () => {
    render(
      <Field label="Groups">
        <CheckList
          options={[
            { value: "a", label: "Ops" },
            { value: "b", label: "NOC" },
          ]}
          value={[]}
          onChange={noop}
        />
        <FormCheckbox label="Inherit" checked={false} onChange={noop} />
      </Field>
    )
    const label = screen.getByText("Groups").closest("label")!
    expect(document.getElementById(label.getAttribute("for")!)).toBeNull()
    for (const box of screen.getAllByRole("checkbox")) {
      expect(box.id).toBe("")
      expect(box.getAttribute("aria-labelledby")).toBeNull()
    }
    expect(screen.getByLabelText("Inherit")).toBeTruthy()
    expect(screen.getByLabelText("NOC")).toBeTruthy()
  })

  it("an open picker's search box does not take the field's id", () => {
    render(
      <FormCombobox
        label="Device type"
        value={null}
        onChange={noop}
        options={[{ value: "x", label: "C9300" }]}
      />
    )
    const trigger = screen.getByRole("combobox")
    fireEvent.click(trigger)
    const listbox = screen.getByRole("dialog")
    const search = within(listbox).getByPlaceholderText("Search…")
    expect(search.id).not.toBe(trigger.id)
    expect(document.querySelectorAll(`[id="${trigger.id}"]`)).toHaveLength(1)
  })

  it("controls outside a Field are untouched", () => {
    render(<Input placeholder="Search" />)
    const input = screen.getByPlaceholderText("Search")
    expect(input.id).toBe("")
    expect(input.getAttribute("aria-labelledby")).toBeNull()
    expect(input.getAttribute("aria-invalid")).toBeNull()
  })
})
