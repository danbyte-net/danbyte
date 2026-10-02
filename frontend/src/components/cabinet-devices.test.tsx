// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Device, DeviceTypeMini, DinRail } from "@/lib/api"
import { CabinetDeviceBodies, nameLayout, railTagAt } from "./cabinet-devices"
import { CabinetElevation } from "./cabinet-elevation"

// The devices on a cabinet's rails are drawn in the plate's millimetres: a
// body at its rail's left end plus its offset, as wide and tall as its type,
// hung so the rail's centreline crosses it at the type's rail position.

const { navMock } = vi.hoisted(() => ({ navMock: vi.fn() }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => navMock,
}))

const R1: DinRail = {
  id: "r1",
  label: "R1",
  profile: "ts35",
  x_mm: 10,
  y_mm: 75,
  length_mm: 500,
}
const R2: DinRail = {
  id: "r2",
  label: "R2",
  profile: "ts35",
  x_mm: 0,
  y_mm: 300,
  length_mm: 120,
}

const type = (patch: Partial<DeviceTypeMini> = {}): DeviceTypeMini => ({
  id: "t1",
  name: "PLC",
  manufacturer: null,
  manufacturer_id: null,
  u_height: 0,
  rack_width: "full",
  is_full_depth: false,
  width_mm: 60,
  height_mm: 147,
  din_profiles: ["ts35"],
  din_rail_mm: null,
  front_image: null,
  rear_image: null,
  ...patch,
})

const device = (
  id: string,
  rail: DinRail | null,
  offset: number | null,
  patch: Partial<Device> = {}
) =>
  ({
    id,
    name: id,
    device_type: type(),
    role: null,
    din_rail: rail
      ? { id: rail.id, label: rail.label, profile: rail.profile }
      : null,
    din_offset_mm: offset,
    cabinet: { id: "c1", name: "K1" },
    ...patch,
  }) as Device

function draw(devices: Device[], highlight?: string) {
  return render(
    <CabinetElevation
      width={525}
      height={625}
      rails={[R1, R2].map((r) => ({ key: r.id, ...r }))}
      railLabels={false}
    >
      <CabinetDeviceBodies
        rails={[R1, R2]}
        devices={devices}
        highlight={highlight}
      />
    </CabinetElevation>
  )
}

/** A drawn device's body: its outline, which every body has. */
const body = (name: string) => {
  const g = document.querySelector(`[data-device="${name}"]`)
  const r = g?.querySelector("[data-part=outline]")
  if (!g || !r) throw new Error(`no device ${name}`)
  const n = (a: string) => Number(r.getAttribute(a))
  return { g, x: n("x"), y: n("y"), width: n("width"), height: n("height") }
}

afterEach(() => {
  cleanup()
  navMock.mockReset()
})

describe("CabinetDeviceBodies", () => {
  it("puts a body at the rail's left end plus its offset, centred on the rail", () => {
    draw([device("plc-1", R1, 120)])
    // 10 + 120 across; 75 - 147 / 2 down.
    expect(body("plc-1")).toMatchObject({
      x: 130,
      y: 1.5,
      width: 60,
      height: 147,
    })
  })

  it("hangs the body from its type's rail position", () => {
    draw([
      device("relay", R2, 30, {
        device_type: type({ width_mm: 18, height_mm: 80, din_rail_mm: 25 }),
      }),
    ])
    expect(body("relay")).toMatchObject({
      x: 30,
      y: 275,
      width: 18,
      height: 80,
    })
  })

  it("leaves out a device off the rails", () => {
    draw([device("loose", null, null), device("plc-1", R1, 0)])
    expect(document.querySelector('[data-device="loose"]')).toBeNull()
    expect(body("plc-1").x).toBe(10)
  })

  it("fills a body with its role's colour, and writes on it in readable ink", () => {
    draw([
      device("plc-1", R1, 0, {
        role: {
          id: "ro1",
          name: "Control",
          slug: "control",
          color: "#facc15",
          icon: "",
        },
      }),
    ])
    const fill = body("plc-1").g.querySelector<SVGElement>("[data-part=body]")
    expect(fill?.style.fill).toBe("rgb(250, 204, 21)") // #facc15
    // A light yellow takes dark ink.
    const name = body("plc-1").g.querySelector<SVGElement>("[data-part=name]")
    expect(name?.style.fill).toBe("rgb(10, 10, 10)") // #0a0a0a
  })

  it("stretches the type's front photo over the body", () => {
    draw([
      device("sw-1", R1, 200, {
        device_type: type({ front_image: "/media/sw.png" }),
      }),
    ])
    const img = body("sw-1").g.querySelector("image")
    expect(img?.getAttribute("href")).toBe("/media/sw.png")
    expect(img?.getAttribute("preserveAspectRatio")).toBe("none")
    expect(
      ["x", "y", "width", "height"].map((a) => img?.getAttribute(a))
    ).toEqual(["210", "1.5", "60", "147"])
    expect(body("sw-1").g.querySelector("[data-part=body]")).toBeNull()
  })

  it("goes to the device on a click, or Enter", () => {
    draw([device("plc-1", R1, 0)])
    fireEvent.click(body("plc-1").g)
    expect(navMock).toHaveBeenCalledWith({
      to: "/devices/$id",
      params: { id: "plc-1" },
    })
    navMock.mockReset()
    fireEvent.keyDown(body("plc-1").g, { key: "Enter" })
    expect(navMock).toHaveBeenCalledTimes(1)
  })

  it("draws the device of the page it is on in the selection colour", () => {
    draw([device("a", R1, 0), device("b", R1, 60)], "a")
    expect(body("a").g.getAttribute("data-selected")).toBe("true")
    expect(body("b").g.hasAttribute("data-selected")).toBe(false)
    // On top of everything else.
    const order = [...document.querySelectorAll("[data-device]")].map((g) =>
      g.getAttribute("data-device")
    )
    expect(order).toEqual(["b", "a"])
  })
})

describe("nameLayout", () => {
  it("writes a name that fits across the body's top", () => {
    expect(nameLayout("plc-1", 80, 120, false)).toEqual({
      text: "plc-1",
      vertical: false,
    })
  })

  it("writes it down a tall, narrow body when more of it fits that way", () => {
    expect(nameLayout("din-test-1", 38, 92, false)).toEqual({
      text: "din-test-1",
      vertical: true,
    })
  })

  it("keeps a photo's name across its top, cut to fit", () => {
    expect(nameLayout("din-test-1", 38, 92, true)).toEqual({
      text: "din-…",
      vertical: false,
    })
  })

  it("leaves the name out where under three of its characters fit", () => {
    expect(nameLayout("din-test-1", 27, 66, true)).toBeNull()
    expect(nameLayout("din-test-1", 11, 50, false)).toBeNull()
  })
})

describe("railTagAt", () => {
  const px = (n: number) => n // a plate drawn one pixel per millimetre

  it("puts a rail's label in the first stretch of the rail left free", () => {
    const devices = [device("a", R1, 0), device("b", R1, 70)]
    // 0-60 and 70-130 are taken; the 10 mm between is too narrow.
    expect(railTagAt(R1, devices, px)).toMatchObject({
      offset: 130,
      covered: false,
    })
    expect(railTagAt(R2, devices, px)).toMatchObject({
      offset: 0,
      covered: false,
    })
  })

  it("keeps it at the left end, over the devices, on a full rail", () => {
    const devices = [device("a", R2, 0), device("b", R2, 60)]
    expect(railTagAt(R2, devices, px)).toMatchObject({
      offset: 0,
      covered: true,
    })
  })
})
