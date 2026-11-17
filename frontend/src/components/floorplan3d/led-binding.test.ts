import { describe, expect, it } from "vitest"
import * as THREE from "three"

import { ledLook } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"

import {
  applyLeds,
  blinkClockRunning,
  findLeds,
  joinBlinkClock,
  ledMaterial,
} from "./led-binding"
import { assembleModel } from "./model-assembly"

const DARK = new THREE.MeshStandardMaterial({ name: "LED", color: "#111111" })

function named(name: string, child?: THREE.Object3D) {
  const o = new THREE.Object3D()
  o.userData.gltfName = name
  if (child) o.add(child)
  return o
}

function led() {
  return new THREE.Mesh(new THREE.BoxGeometry(0.002, 0.002, 0.001), DARK)
}

/** A chassis with SYS (gltfpack -kn: the mesh on a child), a port LED and
 * a bay; a PSU module with its own PS_OK LED and a {module} port LED. */
function scenes() {
  const chassis = new THREE.Group()
  chassis.add(named("led:SYS", led()))
  const port = led()
  port.userData.gltfName = "led:port:Te1/0/1"
  chassis.add(port)
  chassis.add(named("bay:PS-1"))
  const psu = new THREE.Group()
  psu.add(named("led:PS_OK", led()))
  psu.add(named("led:port:Te1/{module}/9", led()))
  return { chassis, psu }
}

describe("findLeds", () => {
  it("finds chassis and bay lights by their glTF names", () => {
    const { chassis, psu } = scenes()
    const { root } = assembleModel(
      chassis,
      [{ bay: "PS-1", position: "1", scene: psu }],
      null
    )
    const bound = findLeds(root)
    const keys = bound.map((b) => `${b.bay ?? "-"}/${b.name}`).sort()
    expect(keys).toEqual([
      "-/SYS",
      "-/port:Te1/0/1",
      "PS-1/PS_OK",
      "PS-1/port:Te1/1/9",
    ])
    // The -kn child mesh is the named node's.
    expect(bound.find((b) => b.name === "SYS")!.meshes).toHaveLength(1)
  })
})

describe("applyLeds", () => {
  it("swaps in a shared material per state and back to dark when off", () => {
    const { chassis, psu } = scenes()
    const { root } = assembleModel(
      chassis,
      [{ bay: "PS-1", position: "1", scene: psu }],
      null
    )
    const bound = findLeds(root)
    const dev: DeviceLeds = {
      leds: { SYS: "green", "port:Te1/0/1": "amber_blink" },
      bays: { "PS-1": { PS_OK: "red" } },
      locate: null,
    }
    expect(applyLeds(bound, dev, false)).toBe(true)
    const mat = (name: string) =>
      bound.find((b) => b.name === name)!.meshes[0]
        .material as THREE.MeshStandardMaterial
    expect(mat("SYS")).toBe(ledMaterial(ledLook("green")))
    expect(mat("SYS").emissive.getHexString()).toBe("22e55c")
    // A lit LED shows from both sides, as the pack's own LED material.
    expect(mat("SYS").side).toBe(THREE.DoubleSide)
    expect(mat("PS_OK")).toBe(ledMaterial(ledLook("red")))
    expect(mat("port:Te1/1/9")).toBe(DARK)
    // Two copies share one material per look.
    const again = findLeds(
      assembleModel(chassis, [{ bay: "PS-1", position: "1", scene: psu }], null)
        .root
    )
    applyLeds(again, dev, false)
    expect(again.find((b) => b.name === "SYS")!.meshes[0].material).toBe(
      mat("SYS")
    )
    // Reduced motion: no blink, the steady colour.
    expect(applyLeds(bound, dev, true)).toBe(false)
    expect(mat("port:Te1/0/1")).toBe(ledMaterial(ledLook("amber")))
    // Everything off: the model's own dark material again.
    expect(applyLeds(bound, null, false)).toBe(false)
    expect(mat("SYS")).toBe(DARK)
  })
})

describe("the blink clock", () => {
  it("runs while someone has joined", () => {
    expect(blinkClockRunning()).toBe(false)
    const leaveA = joinBlinkClock(() => {})
    const leaveB = joinBlinkClock(() => {})
    expect(blinkClockRunning()).toBe(true)
    leaveA()
    expect(blinkClockRunning()).toBe(true)
    leaveB()
    expect(blinkClockRunning()).toBe(false)
  })
})
