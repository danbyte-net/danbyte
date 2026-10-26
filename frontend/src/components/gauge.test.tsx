// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Gauge, formatGaugeValue, gaugeTone } from "./gauge"
import { LookupBar } from "./lookup-bar"
import { TooltipProvider } from "@/components/ui/tooltip"

afterEach(cleanup)

describe("Gauge", () => {
  it("draws the value, the unit, min and max, and no needle", () => {
    const { container, getByRole } = render(
      <Gauge value={81} unit="%" min={0} max={100} label="Free space" />
    )
    const meter = getByRole("meter")
    expect(meter.getAttribute("aria-valuenow")).toBe("81")
    expect(meter.textContent).toContain("81")
    expect(meter.textContent).toContain("%")
    expect(container.querySelector("[data-part=min]")?.textContent).toBe("0")
    expect(container.querySelector("[data-part=max]")?.textContent).toBe("100")
    expect(container.querySelector("[data-part=value]")).toBeTruthy()
    expect(container.querySelector("line")).toBeNull()
    // Squarish everywhere: no pill shapes in the primitive.
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("draws warning and error bands as thin arcs in their colours", () => {
    const { container } = render(
      <Gauge value={81} unit="%" warn={{ below: 25 }} error={{ below: 10 }} />
    )
    const warn = container.querySelector("[data-part=band-warning]")
    const error = container.querySelector("[data-part=band-error]")
    expect(warn?.getAttribute("class")).toContain("amber")
    expect(error?.getAttribute("class")).toContain("destructive")
    expect(
      container.querySelector("[role=meter]")?.getAttribute("data-tone")
    ).toBe("ok")
  })

  it("takes the colour of the zone the value is in", () => {
    expect(gaugeTone(5, { below: 25 }, { below: 10 })).toBe("error")
    expect(gaugeTone(20, { below: 25 }, { below: 10 })).toBe("warning")
    expect(gaugeTone(900, { above: 500 })).toBe("warning")
    expect(gaugeTone(50)).toBe("neutral")
    expect(gaugeTone(null, { below: 1 })).toBe("neutral")
  })

  it("says no data without a value", () => {
    const { getByRole } = render(<Gauge value={null} unit="msec" />)
    expect(getByRole("meter").getAttribute("aria-valuetext")).toBe("No data")
    expect(formatGaugeValue(0.034)).toBe("0.03")
  })
})

describe("LookupBar", () => {
  const states = [
    { key: "0", label: "Yes", tone: "ok" as const },
    { key: "1", label: "No", tone: "warning" as const },
  ]

  it("fills the current segment in its colour and names it", () => {
    const { container, getByText } = render(
      <TooltipProvider>
        <LookupBar states={states} current="1" />
      </TooltipProvider>
    )
    const segs = container.querySelectorAll("[data-tone]")
    expect(segs).toHaveLength(2)
    const current = container.querySelector("[data-current]")
    expect(current?.getAttribute("data-tone")).toBe("warning")
    expect(current?.className).toContain("amber")
    expect(segs[0].className).toContain("bg-muted")
    expect(getByText("No")).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("prefers the given label and copes with no current value", () => {
    const { getByText, container } = render(
      <TooltipProvider>
        <LookupBar states={states} current={null} />
      </TooltipProvider>
    )
    expect(getByText("No data")).toBeTruthy()
    expect(container.querySelector("[data-current]")).toBeNull()
  })
})
