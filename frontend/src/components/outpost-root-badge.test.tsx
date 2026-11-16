// @vitest-environment jsdom
import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import type { MonitoringEngine } from "@/lib/api"
import { OutpostRootBadge, runsAsRoot } from "./outpost-root-badge"

// Agent 0.10 says in hello whether it runs as root; an older agent says
// nothing, which is unknown and shows nothing.
function engine(caps: MonitoringEngine["agent_capabilities"]) {
  return { agent_capabilities: caps } as MonitoringEngine
}

describe("OutpostRootBadge", () => {
  it("warns only when the agent said it runs as root", () => {
    expect(runsAsRoot(engine({ runtime: { root: true } }))).toBe(true)
    expect(runsAsRoot(engine({ runtime: { root: false } }))).toBe(false)
    expect(runsAsRoot(engine({}))).toBe(false)
    expect(runsAsRoot(engine(undefined))).toBe(false)
    expect(runsAsRoot(null)).toBe(false)
  })

  it("renders a warning badge with an info tip, or nothing", () => {
    const root = render(
      <OutpostRootBadge engine={engine({ runtime: { root: true } })} />
    )
    expect(root.getByText("root").getAttribute("data-variant")).toBe("warning")
    expect(root.getByRole("button", { name: "More information" })).toBeTruthy()
    root.unmount()
    const old = render(<OutpostRootBadge engine={engine({})} />)
    expect(old.container.textContent).toBe("")
  })
})
