import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { V3 } from "@/lib/model-ports"

import { keyShadowFor } from "./model-preview"
import { STUDIO_LIGHTS, studioTopLight } from "./studio"
import {
  AO_INTENSITY,
  AO_MAX_PIXELS,
  aoRadiusFor,
  aoSize,
  isHitOnly,
  isOverlay,
  weakGpu,
} from "./viewer-look"

// The device viewer's look: AO, the overlay drawn over it, and the shadow
// lights fitted to the model.

describe("weakGpu", () => {
  it("leaves software renderers and small devices on the plain render", () => {
    expect(weakGpu("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))")).toBe(
      true
    )
    expect(weakGpu("llvmpipe (LLVM 17.0.6, 256 bits)")).toBe(true)
    expect(weakGpu("Microsoft Basic Render Driver")).toBe(true)
    expect(weakGpu("ANGLE (NVIDIA GeForce RTX 3060)", 2)).toBe(true)
    expect(weakGpu("ANGLE (NVIDIA GeForce RTX 3060)", 8)).toBe(false)
    // Firefox masks the name: decided by memory alone.
    expect(weakGpu("")).toBe(false)
  })
})

describe("aoRadiusFor", () => {
  it("reaches about a port cage's depth on a 1U switch, bounded", () => {
    const r1u = aoRadiusFor([0.44, 0.044, 0.46])
    expect(r1u).toBeGreaterThan(0.01)
    expect(r1u).toBeLessThan(0.03)
    expect(aoRadiusFor([0.02, 0.02, 0.02])).toBe(0.008)
    expect(aoRadiusFor([2, 2, 2])).toBe(0.06)
  })

  it("is lighter over baked occlusion", () => {
    expect(AO_INTENSITY.withBaked).toBeLessThan(AO_INTENSITY.screen)
  })
})

describe("aoSize", () => {
  it("works at full size up to the cap, then scales down evenly", () => {
    expect(aoSize(1200, 800)).toEqual([1200, 800])
    const [w, h] = aoSize(5120, 2880)
    expect(w * h).toBeLessThanOrEqual(AO_MAX_PIXELS * 1.001)
    expect(w / h).toBeCloseTo(5120 / 2880, 2)
  })
})

describe("isHitOnly", () => {
  it("keeps pick boxes out of the AO and depth passes", () => {
    const box = new THREE.BoxGeometry()
    const hit = new THREE.Mesh(box, new THREE.MeshBasicMaterial())
    hit.material.visible = false
    expect(isHitOnly(hit)).toBe(true)
    expect(isHitOnly(new THREE.Mesh(box, new THREE.MeshBasicMaterial()))).toBe(
      false
    )
  })
})

describe("isOverlay", () => {
  const box = new THREE.BoxGeometry()
  it("sends markers, outlines, lit LEDs and ghosts past the AO", () => {
    const opaque = new THREE.Mesh(box, new THREE.MeshStandardMaterial())
    expect(isOverlay(opaque)).toBe(false)
    const ghost = new THREE.Mesh(
      box,
      new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.12 })
    )
    expect(isOverlay(ghost)).toBe(true)
    const led = new THREE.Mesh(
      box,
      new THREE.MeshStandardMaterial({ toneMapped: false })
    )
    expect(isOverlay(led)).toBe(true)
    expect(isOverlay(new THREE.LineSegments(box))).toBe(true)
    expect(
      isOverlay(
        new THREE.Mesh(box, [
          new THREE.MeshStandardMaterial(),
          new THREE.MeshBasicMaterial({ transparent: true }),
        ])
      )
    ).toBe(true)
  })
})

describe("the viewer's shadow lights", () => {
  const center: V3 = [0, 0.022, 0]
  const radius = 0.32

  it("fits the key's shadow camera tight around the model", () => {
    const k = keyShadowFor(center, radius)
    const d = new THREE.Vector3(...k.position).distanceTo(
      new THREE.Vector3(...center)
    )
    expect(d).toBeCloseTo(radius * 4)
    // Along the key's direction.
    const dir = new THREE.Vector3(...k.position)
      .sub(new THREE.Vector3(...center))
      .normalize()
    const key = new THREE.Vector3(...STUDIO_LIGHTS.key.position).normalize()
    expect(dir.dot(key)).toBeCloseTo(1)
    expect(k.half).toBeGreaterThanOrEqual(radius)
    expect(k.near).toBeLessThan(d - radius)
    expect(k.far).toBeGreaterThan(d + radius)
    expect(k.normalBias).toBeLessThan(0.002)
  })

  it("gives the top softbox the same light at the centre at any size", () => {
    const small = studioTopLight(center, 0.1)
    const big = studioTopLight(center, 1)
    const at = (t: ReturnType<typeof studioTopLight>) =>
      t.intensity /
      new THREE.Vector3(...t.position).distanceToSquared(
        new THREE.Vector3(...center)
      )
    expect(at(small)).toBeCloseTo(STUDIO_LIGHTS.top.intensity)
    expect(at(big)).toBeCloseTo(STUDIO_LIGHTS.top.intensity)
    // Over the back, its cone taking in the model, its shadow range too.
    expect(big.position[1]).toBeGreaterThan(center[1])
    expect(big.position[2]).toBeGreaterThan(0)
    const d = Math.sqrt(
      new THREE.Vector3(...big.position).distanceToSquared(
        new THREE.Vector3(...center)
      )
    )
    expect(Math.tan(big.angle) * d).toBeGreaterThan(1)
    expect(big.near).toBeLessThan(d - 1)
    expect(big.far).toBeGreaterThan(d + 1)
  })
})
