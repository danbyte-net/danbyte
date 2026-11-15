// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { LED_COLORS } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"

import { LedOverlay } from "./led-overlay"

// Hardware lights on a face image: at their normalised places, in their
// states' colours, blinking where the state blinks - not a dot beside a
// name.

afterEach(cleanup)

const leds: DeviceLeds = {
  leds: { SYS: "green", BEACON: "blue_blink", "port:Te1/0/1": "neutral" },
  bays: { "PS-1": { PS_OK: "red" } },
  locate: null,
}

const positions = [
  { name: "SYS", x: 0.1, y: 0.5, w: 0.004, h: 0.08, source: "device.status" },
  { name: "led:BEACON", x: 0.12, y: 0.5, w: 0.004, h: 0.08 },
  { name: "port:Te1/0/1", x: 0.3, y: 0.25, w: 0.004, h: 0.05 },
  { name: "PS_OK", bay: "PS-1", x: 0.9, y: 0.5, w: 0.004, h: 0.08 },
  { name: "MGMT_ACT", x: 0.2, y: 0.5, w: 0.004, h: 0.08 },
]

function draw(l: DeviceLeds | null = leds) {
  return render(
    <TooltipProvider>
      <div style={{ position: "relative" }}>
        <LedOverlay positions={positions} leds={l} />
      </div>
    </TooltipProvider>
  )
}

const light = (name: string) =>
  document.querySelector(`[data-led="${name}"]`) as HTMLElement

describe("LedOverlay", () => {
  it("draws each light at its place in its state", () => {
    draw()
    const sys = light("SYS")
    expect(sys.style.left).toBe("10%")
    expect(sys.style.top).toBe("50%")
    expect(sys.dataset.ledState).toBe("green")
    // jsdom normalises the colour to rgb().
    expect(sys.style.backgroundColor).toBe("rgb(34, 229, 92)")
    expect(LED_COLORS.green).toBe("#22e55c")
    expect(sys.hasAttribute("data-led-blink")).toBe(false)
    expect(light("BEACON").dataset.ledState).toBe("blue")
    expect(light("BEACON").hasAttribute("data-led-blink")).toBe(true)
    expect(light("port:Te1/0/1").dataset.ledState).toBe("neutral")
    expect(light("PS_OK").dataset.ledState).toBe("red")
    // Not in the payload: off, transparent, still named for the tooltip.
    expect(light("MGMT_ACT").dataset.ledState).toBe("off")
    expect(light("MGMT_ACT").style.backgroundColor).toBe("transparent")
  })

  it("names each light and its state for assistive tech", () => {
    draw()
    expect(screen.getByRole("img", { name: "SYS: Green" })).toBeTruthy()
    expect(
      screen.getByRole("img", { name: "BEACON: Blue, blinking" })
    ).toBeTruthy()
  })

  it("is dark without states, and draws nothing without positions", () => {
    draw(null)
    expect(light("SYS").dataset.ledState).toBe("off")
    cleanup()
    const { container } = render(<LedOverlay positions={[]} leds={leds} />)
    expect(container.innerHTML).toBe("")
  })
})
