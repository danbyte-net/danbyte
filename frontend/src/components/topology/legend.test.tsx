// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CanvasLegend, legendRows } from "./legend"

// The map's legend: roles as their badges and colour keys as lines -
// never a coloured dot beside a name.

afterEach(cleanup)

describe("CanvasLegend", () => {
  it("shows roles as badges and speed tiers as coloured lines", () => {
    const { container } = render(
      <CanvasLegend
        viewStyle="diagram"
        grouped={false}
        colorMode="speed"
        roles={[
          { name: "Spine", color: "6366f1" },
          { name: "Leaf", color: "0ea5e9" },
        ]}
      />
    )
    expect(screen.getByText("Spine")).toBeTruthy()
    expect(screen.getByText("10G")).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
    const tier = screen.getByText("10G").previousElementSibling!
    expect(tier.nodeName.toLowerCase()).toBe("svg")
    expect(tier.querySelector("line")!.getAttribute("stroke")).toBe("#0ea5e9")
  })

  it("keys the media types as lines too", () => {
    const { container } = render(
      <CanvasLegend
        viewStyle="hierarchy"
        grouped={false}
        colorMode="type"
        types={["cat6", "om4"]}
      />
    )
    expect(screen.getByText("cat6")).toBeTruthy()
    expect(container.querySelector(".rounded-full")).toBeNull()
  })
})

describe("legendRows", () => {
  it("lists the Diagram's roles, then its line styles", () => {
    const rows = legendRows({
      viewStyle: "diagram",
      grouped: false,
      colorMode: "cable",
      roles: [{ name: "Spine", color: "#6366f1" }],
    })
    expect(rows[0]).toEqual({ kind: "role", label: "Spine", color: "#6366f1" })
    expect(rows.some((r) => r.kind === "line" && r.sem === "cable")).toBe(true)
  })
})
