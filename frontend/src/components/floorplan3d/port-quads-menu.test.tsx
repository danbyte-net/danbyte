// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"

import type { FacePort, ImagePortMarker } from "@/lib/api"
import { PortQuads } from "./device-mesh"

// A port or bay on a racked device's photo face in the room opens the
// device menus on a right-click - the button pressed and let go where it
// went down. A right-drag pans the camera and opens nothing. A part keeps
// its own status menu; a left-click still picks the port.
//
// The quads are drawn by react-three-fiber; here React DOM renders them as
// plain elements, which carry the same pointer handlers.

beforeAll(() => {
  // React DOM warns about three's intrinsic elements; the handlers are
  // what is under test.
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => cleanup())

const fp = (over: Partial<FacePort>): FacePort => ({
  marker: "",
  name: "",
  kind: null,
  id: null,
  connected: false,
  cable_id: null,
  cable_state: "free",
  enabled: true,
  speed: "",
  type: "",
  status: null,
  module: null,
  drift: null,
  ...over,
})

const marker = (kind: string, name: string): ImagePortMarker => ({
  kind,
  name,
  x: 0.5,
  y: 0.5,
  w: 0.1,
  h: 0.1,
})

const PORT = fp({ marker: "eth1", name: "eth1", kind: "interface", id: "if1" })
const BAY = fp({ marker: "Slot 1", name: "Slot 1", id: "bay1" })
const DISK = fp({ marker: "disk0", name: "disk0", id: "p1" })

function quads() {
  const onObjectMenu = vi.fn()
  const onMenu = vi.fn()
  const onSelect = vi.fn()
  render(
    <PortQuads
      markers={[
        marker("interface", "eth1"),
        marker("module-bay", "Slot 1"),
        marker("inventory-item", "disk0"),
        marker("interface", "ghost"),
      ]}
      resolved={
        new Map([
          ["eth1", PORT],
          ["Slot 1", BAY],
          ["disk0", DISK],
        ])
      }
      observed={null}
      width={0.48}
      height={0.044}
      labelSource=""
      labelColor="#ffffff"
      onSelect={onSelect}
      onMenu={onMenu}
      onObjectMenu={onObjectMenu}
    />
  )
  const quad = (name: string) =>
    document.querySelector<HTMLElement>(`mesh[name="${name}"]`)!
  return { quad, onObjectMenu, onMenu, onSelect }
}

const rightClick = (el: HTMLElement, dx = 0, dy = 0) => {
  fireEvent.pointerDown(el, { button: 2, clientX: 100, clientY: 80 })
  fireEvent.pointerUp(el, { button: 2, clientX: 100 + dx, clientY: 80 + dy })
}

describe("right-click on a port quad in the room", () => {
  it("opens the port's menu at the pointer", () => {
    const { quad, onObjectMenu, onMenu } = quads()
    rightClick(quad("eth1"), 2, 1)
    expect(onObjectMenu).toHaveBeenCalledWith({ port: PORT }, { x: 102, y: 81 })
    expect(onMenu).not.toHaveBeenCalled()
  })

  it("opens a bay's module menu by its name", () => {
    const { quad, onObjectMenu } = quads()
    rightClick(quad("Slot 1"))
    expect(onObjectMenu).toHaveBeenCalledWith(
      { bay: "Slot 1" },
      { x: 100, y: 80 }
    )
  })

  it("opens nothing on a right-drag, which pans the camera", () => {
    const { quad, onObjectMenu } = quads()
    rightClick(quad("eth1"), 30, 0)
    expect(onObjectMenu).not.toHaveBeenCalled()
  })

  it("keeps a part's own status menu", () => {
    const { quad, onObjectMenu, onMenu } = quads()
    rightClick(quad("disk0"))
    expect(onMenu).toHaveBeenCalledTimes(1)
    expect(onObjectMenu).not.toHaveBeenCalled()
  })

  it("offers nothing on a marker with no port behind it", () => {
    const { quad, onObjectMenu, onMenu } = quads()
    rightClick(quad("ghost"))
    expect(onObjectMenu).not.toHaveBeenCalled()
    expect(onMenu).not.toHaveBeenCalled()
  })

  it("leaves a left-click picking the port", () => {
    const { quad, onObjectMenu, onSelect } = quads()
    fireEvent.pointerDown(quad("eth1"), { button: 0 })
    fireEvent.pointerUp(quad("eth1"), { button: 0 })
    fireEvent.click(quad("eth1"))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onObjectMenu).not.toHaveBeenCalled()
  })
})
