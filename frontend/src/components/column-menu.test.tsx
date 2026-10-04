// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ColumnsMenu } from "./column-menu"
import type { ColumnGroup } from "./column-menu"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

afterEach(cleanup)

const LABELS: Record<string, string> = {
  name: "Name",
  status: "Status",
  primary_ip: "Primary IP",
  asset_tag: "Asset tag",
  airflow: "Airflow",
  "site.region": "Region",
  location: "Location",
  cf_owner: "Owner",
}
const GROUPS: Record<string, ColumnGroup> = {
  asset_tag: "fields",
  airflow: "fields",
  "site.region": "related",
  location: "related",
  cf_owner: "custom",
}

function open(seq: string[], hidden: string[], onApply = vi.fn()) {
  render(
    <ColumnsMenu
      label="Columns"
      isForced={false}
      hasUserRow={false}
      seq={seq}
      labelFor={(id) => LABELS[id] ?? id}
      isHidden={(id) => hidden.includes(id)}
      groupFor={(id) => GROUPS[id] ?? "columns"}
      onApply={onApply}
      onReset={() => {}}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: /columns/i }))
  return onApply
}

const rowsText = () =>
  [...document.querySelectorAll("[data-slot=popover-content] div")]
    .filter(
      (el) =>
        (el as HTMLElement).className.includes("uppercase") ||
        (el as HTMLElement).className.includes(
          "font-medium whitespace-nowrap"
        ) ||
        (el as HTMLElement).className.includes("gap-1.5 rounded")
    )
    .map((el) => el.textContent.trim())

describe("ColumnsMenu", () => {
  const seq = [
    "name",
    "status",
    "primary_ip",
    "asset_tag",
    "site.region",
    "location",
    "airflow",
    "cf_owner",
  ]
  const hidden = seq.slice(2)

  it("lists shown columns, then hidden ones by section, alphabetically", () => {
    open(seq, hidden)
    expect(rowsText()).toEqual([
      "Shown",
      "Name",
      "Status",
      "Available",
      "Columns",
      "Primary IP",
      "Fields",
      "Airflow",
      "Asset tag",
      "Related",
      "Location",
      "Region",
      "Custom fields",
      "Owner",
    ])
  })

  it("puts a ticked column at the end of Shown and saves shown then hidden", () => {
    const onApply = open(seq, hidden)
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle Region" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Toggle Status" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    const [order, saved] = onApply.mock.calls[0]
    expect(order.slice(0, 2)).toEqual(["name", "site.region"])
    expect(new Set(order)).toEqual(new Set(seq))
    expect(saved).toContain("status")
    expect(saved).not.toContain("site.region")
  })

  it("offers a search once the list is long, filtering both sections", () => {
    const many = [...seq, ...Array.from({ length: 6 }, (_, i) => `extra_${i}`)]
    open(many, many.slice(2))
    const search = screen.getByRole("textbox", { name: "Search columns" })
    fireEvent.change(search, { target: { value: "reg" } })
    expect(screen.queryByText("Name")).toBeNull()
    expect(screen.getByText("Region")).toBeTruthy()
  })

  it("keeps Save off until something changes", () => {
    open(seq, hidden)
    const save = screen.getByRole("button", { name: "Save" })
    expect((save as HTMLButtonElement).disabled).toBe(true)
  })
})
