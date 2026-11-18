import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { CUTOUT_ALPHA_TEST, smoothCutouts } from "./device-model"

describe("cut-out materials", () => {
  it("draw alpha-masked parts with alpha to coverage, leaving the rest", () => {
    const perforated = new THREE.MeshStandardMaterial({ alphaTest: 0.5 })
    const glass = new THREE.MeshStandardMaterial({
      transparent: true,
      opacity: 0.35,
      alphaTest: 0.01,
    })
    const plain = new THREE.MeshStandardMaterial()
    const g = new THREE.Group()
    const box = new THREE.BoxGeometry()
    g.add(new THREE.Mesh(box, perforated))
    g.add(new THREE.Mesh(box, [glass, plain]))
    smoothCutouts(g)
    expect(perforated.alphaToCoverage).toBe(true)
    // A far perforated sheet averages ~0.36: it must stay over the cut-off.
    expect(perforated.alphaTest).toBe(CUTOUT_ALPHA_TEST)
    expect(0.36).toBeGreaterThan(perforated.alphaTest)
    expect(glass.alphaTest).toBe(0.01)
    // Blended glass sorts and blends; coverage is for masks only.
    expect(glass.alphaToCoverage).toBe(false)
    expect(plain.alphaToCoverage).toBe(false)
    // A clone (rack-kit recolours its parts) keeps it.
    expect(perforated.clone().alphaToCoverage).toBe(true)
  })
})
