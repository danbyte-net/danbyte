import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  SKY_CAP,
  STUDIO_LIGHTS,
  STUDIO_PASSES,
  studioEnvironmentScene,
  studioPass,
} from "./studio"

// The studio light the viewers and the generated images share.

describe("STUDIO_LIGHTS", () => {
  it("tone maps as Blender's default view does", () => {
    expect(STUDIO_LIGHTS.toneMapping).toBe(THREE.AgXToneMapping)
    expect(STUDIO_LIGHTS.exposure).toBeGreaterThan(0)
  })

  it("lights the front from the right, the key brightest", () => {
    // The room's front is −Z; facing it, the viewer's right is −X, across
    // from the three-quarter camera (+X).
    expect(STUDIO_LIGHTS.key.position[2]).toBeLessThan(0)
    expect(STUDIO_LIGHTS.key.position[0]).toBeLessThan(0)
    expect(STUDIO_LIGHTS.key.intensity).toBeGreaterThan(
      STUDIO_LIGHTS.fill.intensity
    )
    const [softbox, ...rest] = STUDIO_LIGHTS.panels
    expect(softbox.position[2]).toBeLessThan(0)
    for (const p of rest)
      expect(p.intensity).toBeLessThanOrEqual(softbox.intensity)
  })
})

describe("studioEnvironmentScene", () => {
  it("is a gray world with every panel facing the centre", () => {
    const { scene, dispose } = studioEnvironmentScene()
    expect((scene.background as THREE.Color).r).toBeCloseTo(STUDIO_LIGHTS.world)
    const meshes = scene.children.filter(
      (c): c is THREE.Mesh => c instanceof THREE.Mesh
    )
    expect(meshes).toHaveLength(STUDIO_LIGHTS.panels.length)
    meshes.forEach((m, i) => {
      const p = STUDIO_LIGHTS.panels[i]
      // A plane faces its local +Z; lookAt turns that to the centre.
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(m.quaternion)
      const toCentre = m.position.clone().negate().normalize()
      expect(normal.dot(toCentre)).toBeCloseTo(1)
      const c = (m.material as THREE.MeshBasicMaterial).color
      expect(c.r).toBeCloseTo(p.intensity)
      expect((m.material as THREE.Material).toneMapped).toBe(false)
    })
    dispose()
  })
})

describe("studioPass", () => {
  const passes = Array.from({ length: STUDIO_PASSES }, (_, i) =>
    studioPass(i, STUDIO_PASSES)
  )

  it("is deterministic", () => {
    expect(studioPass(5, 32)).toEqual(studioPass(5, 32))
  })

  it("keeps the key on its softbox, the unit disc", () => {
    for (const p of passes) expect(Math.hypot(...p.key)).toBeLessThanOrEqual(1)
  })

  it("sends the sky light from overhead, never near the horizon", () => {
    for (const p of passes) {
      expect(Math.hypot(...p.sky)).toBeCloseTo(1)
      expect(p.sky[1]).toBeGreaterThanOrEqual(Math.sqrt(1 - SKY_CAP) - 1e-9)
    }
    const meanUp = passes.reduce((a, p) => a + p.sky[1], 0) / passes.length
    // Cosine-weighted over the cap: (2/3)(1 - (1 - c)^1.5) / c.
    const c = SKY_CAP
    expect(meanUp).toBeCloseTo(((2 / 3) * (1 - (1 - c) ** 1.5)) / c, 2)
  })

  it("spreads round the sky, not to one side", () => {
    const x = passes.reduce((a, p) => a + p.sky[0], 0) / passes.length
    const z = passes.reduce((a, p) => a + p.sky[2], 0) / passes.length
    expect(Math.abs(x)).toBeLessThan(0.15)
    expect(Math.abs(z)).toBeLessThan(0.15)
  })
})
