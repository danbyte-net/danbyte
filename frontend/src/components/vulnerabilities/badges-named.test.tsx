// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { PriorityBadge, SeverityBadge } from "./badges"

describe("named vulnerability badges (#522)", () => {
  afterEach(cleanup)

  it("names each badge in a record header", () => {
    render(
      <TooltipProvider>
        <PriorityBadge value="medium" name="Priority" />
        <SeverityBadge value="medium" name="CVSS" score={5.3} />
      </TooltipProvider>
    )
    expect(screen.getByText("Priority").parentElement?.textContent).toBe(
      "PriorityMedium"
    )
    expect(screen.getByText("CVSS").parentElement?.textContent).toBe(
      "CVSSMedium5.3"
    )
  })

  it("stays a bare level in tables", () => {
    const { container } = render(<SeverityBadge value="high" />)
    expect(container.textContent).toBe("High")
  })
})
