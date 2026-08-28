// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { DcimChoices } from "@/lib/api"
import type { CustomizationMeta } from "@/lib/custom-fields"
import { FieldEditor } from "./field-editor"
import type { FieldEditorOptions } from "./field-editor"
import type { BulkFieldSpec } from "./field-spec"

// One editor serves the component bulk-edit dialog (mode="keep": an untouched
// field means "leave every selected row alone") and single-object forms
// (mode="always"). These pin the transitions the bulk bar depends on: the
// values map only ever gains a key when the user arms the field, and unarming
// deletes it again.

// jsdom implements none of these, and the popover/command primitives behind
// the choice combobox probe all three on mount.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const NO_CHOICES: DcimChoices = {
  interface_duplex: [],
  interface_modes: [],
  poe_modes: [],
  poe_types: [],
  interface_types: [],
  cable_types: [],
  front_port_types: [],
  console_port_types: [],
  power_port_types: [],
  power_outlet_types: [],
  aux_port_types: [],
  antenna_types: [],
  antenna_bands: [],
  antenna_polarizations: [],
  rf_connector_types: [],
  feed_legs: [],
  connector_fibers: {},
  common_speeds: [],
}

function makeOptions(
  over: Partial<FieldEditorOptions> = {}
): FieldEditorOptions {
  return {
    dcimChoices: NO_CHOICES,
    vlans: [],
    vrfs: [],
    statuses: [],
    tags: [],
    ...over,
  }
}

/** FieldEditor + the props the caller owns; returns the onChange/onClear spies. */
function mount(
  spec: BulkFieldSpec,
  props: Partial<Parameters<typeof FieldEditor>[0]> = {}
) {
  const onChange = vi.fn()
  const onClear = vi.fn()
  const view = render(
    <FieldEditor
      spec={spec}
      value={undefined}
      onChange={onChange}
      onClear={onClear}
      options={makeOptions()}
      {...props}
    />
  )
  return { onChange, onClear, view }
}

const checkbox = () => screen.getByRole("checkbox")
const textbox = () => screen.getByRole("textbox")
const spinner = () => screen.getByRole("spinbutton")

afterEach(cleanup)

describe("FieldEditor per kind", () => {
  it("renders a bool as a tri-state select that starts on Keep current", () => {
    mount({ key: "enabled", label: "Enabled", kind: "bool" })
    // Radix keeps its items unmounted while closed, so assert on the trigger's
    // own value text plus the label wired through <Field/>.
    expect(screen.getByText("Enabled")).toBeTruthy()
    const trigger = screen.getByRole("combobox")
    expect(trigger.textContent).toContain("Keep current")
  })

  it("shows a bool that has been set, and drops Keep current in always mode", () => {
    const { view } = mount(
      { key: "enabled", label: "Enabled", kind: "bool" },
      { value: true }
    )
    expect(screen.getByRole("combobox").textContent).toContain("Yes")
    view.rerender(
      <FieldEditor
        spec={{ key: "enabled", label: "Enabled", kind: "bool" }}
        value={false}
        mode="always"
        onChange={() => {}}
        options={makeOptions()}
      />
    )
    expect(screen.getByRole("combobox").textContent).toContain("No")
  })

  it("populates a choice field from the dcim list and sets the picked value", () => {
    const dcimChoices: DcimChoices = {
      ...NO_CHOICES,
      interface_types: [
        { value: "1000base-t", label: "1000BASE-T", group: "Ethernet" },
        { value: "10gbase-t", label: "10GBASE-T", group: "Ethernet" },
      ],
    }
    const onChange = vi.fn()
    const onClear = vi.fn()
    render(
      <FieldEditor
        spec={{
          key: "type",
          label: "Type",
          kind: "choice",
          choices: "interface_types",
        }}
        value={undefined}
        onChange={onChange}
        onClear={onClear}
        options={makeOptions({ dcimChoices })}
      />
    )
    const trigger = screen.getByRole("combobox")
    expect(trigger.textContent).toContain("Keep current")

    fireEvent.click(trigger)
    // Keep / Clear sentinels sit above the real options.
    expect(screen.getByText("Clear type")).toBeTruthy()
    fireEvent.click(screen.getByText("10GBASE-T"))
    expect(onChange).toHaveBeenCalledWith("10gbase-t")
    expect(onClear).not.toHaveBeenCalled()
  })

  it("arms an int with null, then sends numbers", () => {
    const spec: BulkFieldSpec = { key: "mtu", label: "MTU", kind: "int" }
    const { onChange, view } = mount(spec)
    expect(spinner()).toHaveProperty("disabled", true)

    fireEvent.click(checkbox())
    expect(onChange).toHaveBeenCalledWith(null)

    const armed = vi.fn()
    view.rerender(
      <FieldEditor
        spec={spec}
        value={9000}
        onChange={armed}
        onClear={() => {}}
        options={makeOptions()}
      />
    )
    expect(spinner()).toHaveProperty("value", "9000")
    fireEvent.change(spinner(), { target: { value: "1500" } })
    expect(armed).toHaveBeenCalledWith(1500)
    // Emptying an armed int clears it rather than sending NaN.
    fireEvent.change(spinner(), { target: { value: "" } })
    expect(armed).toHaveBeenCalledWith(null)
  })

  it("renders an object field with the reference-registry picker", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const meta: CustomizationMeta = {
      models: [],
      reference_models: [
        {
          value: "site",
          label: "Sites",
          endpoint: "/api/sites/",
          label_field: "name",
          picker: true,
          route: "/sites",
        },
      ],
    }
    qc.setQueryData(["customization-meta"], meta)
    render(
      <QueryClientProvider client={qc}>
        <FieldEditor
          spec={{
            key: "site",
            label: "Site",
            kind: "object",
            object_model: "site",
          }}
          value={null}
          onChange={() => {}}
          options={makeOptions()}
        />
      </QueryClientProvider>
    )
    expect(screen.getByText("Site")).toBeTruthy()
    expect(screen.queryByText(/Unknown object type/)).toBeNull()
    expect(screen.getByRole("combobox")).toBeTruthy()
  })

  it("notes an object field whose slug is not in the registry", () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    qc.setQueryData(["customization-meta"], {
      models: [],
      reference_models: [],
    } satisfies CustomizationMeta)
    render(
      <QueryClientProvider client={qc}>
        <FieldEditor
          spec={{
            key: "widget",
            label: "Widget",
            kind: "object",
            object_model: "widget",
          }}
          value={null}
          onChange={() => {}}
          options={makeOptions()}
        />
      </QueryClientProvider>
    )
    expect(screen.getByText(/Unknown object type "widget"/)).toBeTruthy()
    expect(screen.queryByRole("combobox")).toBeNull()
  })
})

describe('mode="keep" arming', () => {
  const spec: BulkFieldSpec = {
    key: "description",
    label: "Description",
    kind: "text",
  }

  it("arms a text field with an empty string and unarms via onClear", () => {
    const { onChange, onClear, view } = mount(spec)
    expect(checkbox().getAttribute("aria-checked")).toBe("false")
    expect(textbox()).toHaveProperty("disabled", true)
    expect(textbox().getAttribute("placeholder")).toBe("Keep current")

    // Ticking the box adds the key to the bulk dialog's values map…
    fireEvent.click(checkbox())
    expect(onChange).toHaveBeenCalledWith("")

    view.rerender(
      <FieldEditor
        spec={spec}
        value=""
        onChange={onChange}
        onClear={onClear}
        options={makeOptions()}
      />
    )
    expect(checkbox().getAttribute("aria-checked")).toBe("true")
    expect(textbox()).toHaveProperty("disabled", false)

    // …and unticking it deletes the key again, so the field is left alone.
    fireEvent.click(checkbox())
    expect(onClear).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('has no arming checkbox in mode="always"', () => {
    render(
      <FieldEditor
        spec={spec}
        value="core uplink"
        mode="always"
        onChange={() => {}}
        options={makeOptions()}
      />
    )
    expect(screen.queryByRole("checkbox")).toBeNull()
    expect(textbox()).toHaveProperty("value", "core uplink")
    expect(textbox()).toHaveProperty("disabled", false)
  })
})

describe("suggestion-backed text", () => {
  it("uses the suggest input and still honours arming", () => {
    const { onChange } = mount({
      key: "speed",
      label: "Speed",
      kind: "text",
      suggestions: ["1G", "10G"],
    })
    // SuggestInput is a free-text input with a dropdown, so it reports as a
    // combobox rather than a plain textbox.
    const input = screen.getByPlaceholderText("Keep current")
    expect(input).toHaveProperty("disabled", true)
    expect(screen.getByLabelText("Show common values")).toBeTruthy()
    fireEvent.click(checkbox())
    expect(onChange).toHaveBeenCalledWith("")
  })
})
