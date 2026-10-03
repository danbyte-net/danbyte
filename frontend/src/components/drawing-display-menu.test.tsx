// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { afterEach, describe, expect, it } from "vitest"

import { setLivePortsShown, useLivePortsShown } from "@/lib/live-ports-pref"
import { DrawingDisplayMenu } from "./drawing-display-menu"

// Display ▾ on a drawing's toolbar: its ticks flip in place, the menu
// staying open for the next one, and its one-of-a-few choice is the rack's
// Show. The Ports tick is this browser's, shared by every drawing.

afterEach(cleanup)

const open = () =>
  fireEvent.pointerDown(
    screen.getByRole("button", { name: "Display" }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )

function Harness() {
  const [text, setText] = useState(true)
  const ports = useLivePortsShown()
  const [show, setShow] = useState<"all" | "front" | "rear">("all")
  return (
    <>
      <DrawingDisplayMenu<"all" | "front" | "rear">
        ticks={[
          { label: "Text", checked: text, onChange: setText },
          { label: "Ports", checked: ports, onChange: setLivePortsShown },
        ]}
        choice={{
          label: "Show",
          value: show,
          options: [
            { value: "all", label: "All" },
            { value: "front", label: "Front-mounted" },
            { value: "rear", label: "Rear-mounted" },
          ],
          onChange: setShow,
        }}
      />
      <output>{`${text}|${ports}|${show}`}</output>
    </>
  )
}

describe("DrawingDisplayMenu", () => {
  it("flips its ticks in place and picks one of its choices", () => {
    render(<Harness />)
    open()
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Text" }))
    // Still open for the next tick.
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Ports" }))
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Ports" })
        .getAttribute("aria-checked")
    ).toBe("false")
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Rear-mounted" }))
    expect(document.querySelector("output")!.textContent).toBe(
      "false|false|rear"
    )
    // The Ports tick is kept in this browser.
    expect(localStorage.getItem("danbyte.livePorts.shown")).toBe("0")
    act(() => setLivePortsShown(true))
    expect(localStorage.getItem("danbyte.livePorts.shown")).toBe("1")
  })
})
