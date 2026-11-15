import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { fittedModel } from "@/components/floorplan3d/device-model"
import type { Model3DFit, Model3DFront, Model3DUp } from "@/lib/api"

import {
  imageLedsFromBoxes,
  imagePortsFromAnchors,
  portBoxKind,
} from "./model-studio"
import type { FaceFrame, LedBox, PortAnchor, V3 } from "./model-studio"
import cases from "./studio-projection.cases.json"

/*
 * The cases api/tests_model_pack_renders.py runs through the server's copy
 * (api.model_projection): a pack's Blender renders get their ports and
 * LEDs placed there, a browser render's here, and both must agree.
 */

/** Numbers equal to 5 places, the docs' rounding; everything else exact. */
function close(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number")
    expect(Math.abs((actual as number) - expected), path).toBeLessThan(2e-5)
    return
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true)
    expect((actual as unknown[]).length, path).toBe(expected.length)
    expected.forEach((e, i) =>
      close((actual as unknown[])[i], e, `${path}[${i}]`)
    )
    return
  }
  if (expected && typeof expected === "object") {
    const a = actual as Record<string, unknown>
    expect(Object.keys(a).sort(), path).toEqual(Object.keys(expected).sort())
    for (const [k, v] of Object.entries(expected))
      close(a[k], v, `${path}.${k}`)
    return
  }
  expect(actual, path).toEqual(expected)
}

describe("studio projection parity with the server", () => {
  it("places ports like api.model_projection", () => {
    for (const c of cases.ports) {
      const got = imagePortsFromAnchors(
        c.anchors as unknown as PortAnchor[],
        c.index as Record<string, [string, string]>,
        c.frame as FaceFrame
      )
      close(got, c.expected)
    }
  })

  it("places LEDs like api.model_projection", () => {
    for (const c of cases.leds) {
      const sources = c.sources as Record<string, string>
      const got = imageLedsFromBoxes(
        c.boxes as unknown as LedBox[],
        (b) => sources[`${b.bay ?? ""}|${b.id}`],
        c.frame as FaceFrame,
        c.depth
      )
      close(got, c.expected)
    }
  })

  it("picks the same port boxes", () => {
    for (const [kind, type, want] of cases.port_box_kind)
      expect(portBoxKind(kind, type), `${kind} ${type}`).toBe(want)
  })

  it("fits the model like api.model_projection.Fit", () => {
    for (const c of cases.fit) {
      const [lo, hi] = c.box
      const fit = fittedModel(
        new THREE.Box3(new THREE.Vector3(...lo), new THREE.Vector3(...hi)),
        {
          fit: c.fit as Model3DFit,
          up: c.up as Model3DUp,
          front: c.front as Model3DFront,
        },
        (c.target as { w?: number; h?: number; d?: number } | null) ?? null
      )
      const at = (p: number[]): V3 => {
        const v = new THREE.Vector3(...(p as V3))
          .applyEuler(fit.rotation)
          .multiplyScalar(fit.scale)
          .add(new THREE.Vector3(...fit.position))
        return [v.x, v.y, v.z]
      }
      const dir = (d: number[]): V3 => {
        const v = new THREE.Vector3(...(d as V3)).applyEuler(fit.rotation)
        return [v.x, v.y, v.z]
      }
      close(c.points.map(at), c.expected_points)
      close(c.dirs.map(dir), c.expected_dirs)
    }
  })
})
