// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { PanelLayoutItem } from "@/lib/api"

import { CalloutEditor, LayoutEditor } from "./panel-layouts-card"

// The panel layout editor: the entries in order, a chip per field not yet
// listed (custom fields of the kind among them), a section to add.

vi.mock("@/lib/api-all", () => ({
  apiAll: vi.fn(() =>
    Promise.resolve({
      results: [{ key: "owner", label: "Owner", hidden: false }],
    })
  ),
}))

afterEach(cleanup)

const FIELDS = [
  { key: "status", label: "Status", computed: false },
  { key: "serial_number", label: "Serial", computed: false },
  { key: "monitoring", label: "Monitoring", computed: true },
]

function Harness({ onItems }: { onItems: (i: PanelLayoutItem[]) => void }) {
  const [entries, setEntries] = useState([
    { uid: "a", item: { section: "Device" } as PanelLayoutItem },
    { uid: "b", item: { field: "status" } as PanelLayoutItem },
  ])
  return (
    <LayoutEditor
      entries={entries}
      onChange={(next) => {
        setEntries(next)
        onItems(next.map((e) => e.item))
      }}
      fields={FIELDS}
      cfModel="device"
    />
  )
}

describe("LayoutEditor", () => {
  it("adds fields, custom fields and sections, and removes them", async () => {
    const onItems = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <Harness onItems={onItems} />
      </QueryClientProvider>
    )
    // Status is listed, so it has no chip.
    expect(screen.queryByRole("button", { name: "Status" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Serial" }))
    expect(onItems).toHaveBeenLastCalledWith([
      { section: "Device" },
      { field: "status" },
      { field: "serial_number" },
    ])
    fireEvent.click(await screen.findByRole("button", { name: "Owner" }))
    expect(onItems.mock.lastCall?.[0].at(-1)).toEqual({ field: "cf:owner" })
    fireEvent.click(screen.getByRole("button", { name: "Section" }))
    expect(onItems.mock.lastCall?.[0].at(-1)).toEqual({ section: "Section" })
    fireEvent.click(screen.getByRole("button", { name: "Remove Status" }))
    expect(onItems.mock.lastCall?.[0]).not.toContainEqual({ field: "status" })
    fireEvent.change(
      screen.getAllByRole("textbox", { name: "Section label" })[0],
      {
        target: { value: "Facts" },
      }
    )
    expect(onItems.mock.lastCall?.[0][0]).toEqual({ section: "Facts" })
  })
})

describe("CalloutEditor", () => {
  function CalloutHarness({ onValue }: { onValue: (v: string[]) => void }) {
    const [value, setValue] = useState<string[]>(["status"])
    return (
      <CalloutEditor
        value={value}
        onChange={(v) => {
          setValue(v)
          onValue(v)
        }}
        fields={FIELDS}
        allowed={["status", "serial_number"]}
        max={3}
        cfModel="device"
      />
    )
  }

  it("adds up to the most, in order, never a block, and removes", async () => {
    const onValue = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CalloutHarness onValue={onValue} />
      </QueryClientProvider>
    )
    // A block is never offered.
    expect(
      screen.queryByRole("button", { name: "Add Monitoring to the callout" })
    ).toBeNull()
    fireEvent.click(
      screen.getByRole("button", { name: "Add Serial to the callout" })
    )
    expect(onValue).toHaveBeenLastCalledWith(["status", "serial_number"])
    fireEvent.click(
      await screen.findByRole("button", { name: "Add Owner to the callout" })
    )
    expect(onValue).toHaveBeenLastCalledWith([
      "status",
      "serial_number",
      "cf:owner",
    ])
    // Full: nothing more to add.
    expect(
      screen.queryAllByRole("button", { name: /to the callout$/ })
    ).toEqual([])
    fireEvent.click(screen.getByRole("button", { name: "Move Owner up" }))
    expect(onValue).toHaveBeenLastCalledWith([
      "status",
      "cf:owner",
      "serial_number",
    ])
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Status from the callout" })
    )
    expect(onValue).toHaveBeenLastCalledWith(["cf:owner", "serial_number"])
  })
})
