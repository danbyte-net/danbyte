// @vitest-environment jsdom
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import {
  FACET_TOP,
  FacetGroup,
  FacetVisibilityProvider,
  FilterRail,
  type FacetOption,
} from "./filter-rail"
import { facetPrefId } from "@/lib/use-facet-prefs"

afterEach(cleanup)

const many: FacetOption[] = Array.from({ length: 30 }, (_, i) => ({
  value: `m${i}`,
  label: `Maker ${i}`,
  count: 30 - i,
}))

function Facet({
  options = many,
  initial = [] as string[],
}: {
  options?: FacetOption[]
  initial?: string[]
}) {
  const [sel, setSel] = useState(new Set(initial))
  return (
    <FacetGroup
      label="Manufacturer"
      facetId="manufacturer"
      options={options}
      selected={sel}
      onToggle={(v) => {
        const next = new Set(sel)
        if (next.has(v)) next.delete(v)
        else next.add(v)
        setSel(next)
      }}
    />
  )
}

const boxes = () => screen.queryAllByRole("checkbox")

describe("facet lists (#285)", () => {
  it("shows a short list whole, with no search", () => {
    render(<Facet options={many.slice(0, 5)} />)
    expect(boxes()).toHaveLength(5)
    expect(screen.queryByLabelText("Search Manufacturer")).toBeNull()
  })

  it("shows the top of a long list until Show all", () => {
    render(<Facet />)
    expect(boxes()).toHaveLength(FACET_TOP)
    fireEvent.click(screen.getByText("Show all 30"))
    expect(boxes()).toHaveLength(30)
    fireEvent.click(screen.getByText("Show fewer"))
    expect(boxes()).toHaveLength(FACET_TOP)
  })

  it("keeps a ticked option beyond the cut in sight", () => {
    render(<Facet initial={["m25"]} />)
    expect(boxes()).toHaveLength(FACET_TOP + 1)
    expect(screen.getByLabelText("Maker 25")).toBeTruthy()
  })

  it("searches a long list", () => {
    render(<Facet />)
    fireEvent.change(screen.getByLabelText("Search Manufacturer"), {
      target: { value: "maker 2" },
    })
    // Maker 2, 20-29.
    expect(boxes()).toHaveLength(11)
    fireEvent.change(screen.getByLabelText("Search Manufacturer"), {
      target: { value: "nope" },
    })
    expect(screen.getByText("No matches")).toBeTruthy()
  })
})

function HideableRail({ initial = [] as string[], selected = [] as string[] }) {
  const [hidden, setHidden] = useState(initial)
  return (
    <FacetVisibilityProvider value={{ hidden, setHidden }}>
      <FilterRail>
        <Facet options={many.slice(0, 3)} initial={selected} />
      </FilterRail>
    </FacetVisibilityProvider>
  )
}

describe("hiding facets (#285)", () => {
  it("offers no hide control without a stored list", () => {
    render(<Facet options={many.slice(0, 3)} />)
    expect(screen.queryByLabelText("Hide Manufacturer")).toBeNull()
  })

  it("hides a facet and shows it again", () => {
    render(<HideableRail />)
    fireEvent.click(screen.getByLabelText("Hide Manufacturer"))
    expect(screen.queryByRole("heading", { name: "Manufacturer" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Manufacturer" }))
    expect(screen.getByRole("heading", { name: "Manufacturer" })).toBeTruthy()
  })

  it("keeps a hidden facet with a selection visible", () => {
    render(<HideableRail initial={["manufacturer"]} selected={["m1"]} />)
    expect(screen.getByRole("heading", { name: "Manufacturer" })).toBeTruthy()
  })

  it("stores per list, not per object", () => {
    expect(facetPrefId("/devices/")).toBe("facets-devices")
    expect(facetPrefId("/devices/$id")).toBe("facets-devices-id")
    expect(facetPrefId("/racks/elevations")).toBe("facets-racks-elevations")
    expect(facetPrefId("")).toBeUndefined()
  })
})
