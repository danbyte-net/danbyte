// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { SnmpPollSource } from "./device-snmp-card"

// The device and the VM SNMP cards share this line: where Poll now runs,
// read from the observation's `poll_outpost` (#325).

afterEach(cleanup)

describe("SnmpPollSource", () => {
  it("names the Outpost", () => {
    const { container } = render(
      <SnmpPollSource state={{ poll_outpost: "branch-op" }} />
    )
    expect(container.textContent).toBe("Polls from Outpost branch-op")
  })

  it("says the core when the API answers null", () => {
    const { container } = render(
      <SnmpPollSource state={{ poll_outpost: null }} />
    )
    expect(container.textContent).toBe("Polls from the core")
  })

  it("renders nothing before the API says", () => {
    const { container } = render(<SnmpPollSource state={{}} />)
    expect(container.textContent).toBe("")
    expect(
      render(<SnmpPollSource state={undefined} />).container.textContent
    ).toBe("")
  })
})
