// @vitest-environment jsdom
import { useState } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import {
  LegendFrame,
  LegendItems,
  LegendPills,
  LegendStatuses,
  LegendTones,
} from "./map-legend"

// The maps' one legend frame, and its rows: catalog colours as pills and
// colour keys as lines - never a coloured dot beside a name.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}
afterEach(cleanup)
beforeEach(() => localStorage.clear())

const wrap = (ui: React.ReactNode) =>
  render(<TooltipProvider>{ui}</TooltipProvider>)

describe("LegendFrame", () => {
  it("is the topology legend's box: bordered, opaque, no shadow or blur", () => {
    const { container } = wrap(
      <LegendFrame storageKey="t">
        <p>rows</p>
      </LegendFrame>
    )
    const box = container.firstElementChild as HTMLElement
    // Parity with the legend it was lifted from.
    expect(box.className).toBe(
      "rounded-md border border-border bg-background p-2.5 pt-1.5 text-[11px] w-60"
    )
    expect(box.className).not.toMatch(/shadow|backdrop-blur|\/9\d/)
    expect(screen.getByText("Legend")).toBeTruthy()
    expect(screen.getByText("rows")).toBeTruthy()
  })

  it("takes the width its rows need", () => {
    const { container } = wrap(
      <LegendFrame storageKey="t" className="w-fit">
        x
      </LegendFrame>
    )
    const cls = (container.firstElementChild as HTMLElement).className
    expect(cls).toContain("w-fit")
    expect(cls).not.toContain("w-60")
  })

  it("folds to a Legend chip and remembers the choice", () => {
    wrap(
      <LegendFrame storageKey="legend-test">
        <p>rows</p>
      </LegendFrame>
    )
    fireEvent.click(screen.getByRole("button", { name: "Hide legend" }))
    expect(localStorage.getItem("legend-test")).toBe("closed")
    expect(screen.queryByText("rows")).toBeNull()
    const chip = screen.getByRole("button", { name: "Legend" })
    expect(chip.className).toContain("shadow-none")
    expect(chip.querySelector(".lucide-list")).not.toBeNull()
    fireEvent.click(chip)
    expect(localStorage.getItem("legend-test")).toBe("open")
    expect(screen.getByText("rows")).toBeTruthy()
  })

  it("starts folded when asked, and reads the stored choice first", () => {
    wrap(
      <LegendFrame storageKey="folded" defaultOpen={false}>
        <p>rows</p>
      </LegendFrame>
    )
    expect(screen.queryByText("rows")).toBeNull()
    cleanup()
    localStorage.setItem("folded", "open")
    wrap(
      <LegendFrame storageKey="folded" defaultOpen={false}>
        <p>rows</p>
      </LegendFrame>
    )
    expect(screen.getByText("rows")).toBeTruthy()
  })

  it("can be held by the page", () => {
    function Page() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <span data-testid="state">{String(open)}</span>
          <LegendFrame open={open} onOpenChange={setOpen}>
            <p>rows</p>
          </LegendFrame>
        </>
      )
    }
    wrap(<Page />)
    fireEvent.click(screen.getByRole("button", { name: "Legend" }))
    expect(screen.getByTestId("state").textContent).toBe("true")
    expect(screen.getByText("rows")).toBeTruthy()
  })
})

describe("legend rows", () => {
  it("draws roles and statuses as their pills, never a dot", () => {
    const { container } = render(
      <>
        <LegendPills
          items={[
            { name: "Spine", color: "6366f1" },
            { name: "Leaf", color: null },
          ]}
        />
        <LegendStatuses
          statuses={[
            { id: "s1", name: "Active", color: "#10b981", text_color: "" },
            { id: "s2", name: "Planned", color: "", text_color: "" },
          ]}
        />
      </>
    )
    const pills = container.querySelectorAll("[data-slot=badge]")
    expect([...pills].map((p) => p.textContent)).toEqual([
      "Spine",
      "Leaf",
      "Active",
      "Planned",
    ])
    expect(container.querySelector(".rounded-full")).toBeNull()
    // The status's own colour, from its record.
    expect((pills[2] as HTMLElement).style.backgroundColor).toBe(
      "rgb(16, 185, 129)"
    )
  })

  it("keys a colour mode as short lines, wrapping", () => {
    const { container } = render(
      <LegendTones
        tones={[
          { label: "1G", color: "#10b981" },
          { label: "cat6", color: "#0ea5e9", mono: true },
        ]}
      />
    )
    const row = container.firstElementChild as HTMLElement
    expect(row.className).toContain("flex-wrap")
    const swatch = screen.getByText("1G").previousElementSibling!
    expect(swatch.nodeName.toLowerCase()).toBe("svg")
    expect(swatch.querySelector("line")!.getAttribute("stroke")).toBe("#10b981")
    expect(screen.getByText("cat6").className).toContain("font-mono")
  })

  it("lists items in order: pills, then rows, then the tones or the note", () => {
    const { container } = render(
      <LegendItems
        maxRoles={1}
        rows={[
          { kind: "role", label: "Spine", color: "#6366f1" },
          { kind: "role", label: "Leaf" },
          { kind: "line", label: "Cable" },
          { kind: "box", label: "Patch panel", dashed: true },
          { kind: "note", label: "Color by cable" },
        ]}
      />
    )
    // One role pill: the cap holds.
    expect(container.querySelectorAll("[data-slot=badge]")).toHaveLength(1)
    expect(container.textContent).toBe("SpineCablePatch panelColor by cable")
    expect(
      screen.getByText("Patch panel").previousElementSibling!.className
    ).toContain("border-dashed")
  })

  it("lets a map draw its own swatches", () => {
    render(
      <LegendItems
        rows={[{ kind: "line", label: "VLAN", width: 8 }]}
        swatch={() => <i data-testid="own" />}
      />
    )
    expect(screen.getByTestId("own")).toBeTruthy()
  })
})
