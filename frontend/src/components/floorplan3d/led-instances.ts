import * as THREE from "three"

import { ledLook, ledStateOf } from "@/lib/led-state"
import type { DeviceLeds } from "@/lib/led-state"

import { LED_PHASE } from "./led-binding"

/**
 * Status LEDs of instanced rack models (docs/features/floor-plans.md → 3D
 * models in racks): every `led:` mesh of a model merged into ONE geometry,
 * drawn as one instanced mesh for every device of the group - a 48-port
 * switch's lights cost one draw call per group, not one per light per
 * device.
 *
 * Each vertex carries the index of its light and the light's own dark
 * colour; each instance reads its lights' looks from a small float
 * texture (one texel per light per device: the lit colour, and whether it
 * is lit steady, blinking or off). Unlit, as the far copies always were -
 * a lit LED is a light, not a surface - and a blinking one follows the
 * shared blink clock (led-binding's `LED_PHASE`), every light in step.
 */

/** One light of the merged batch: what it is called and where it sits. */
export interface BatchLed {
  name: string
  bay: string | null
}

/** A light to merge: its mesh, its matrix in the copy's frame and its
 * own dark colour. */
export interface LedSource {
  mesh: THREE.Mesh
  local: THREE.Matrix4
  name: string
  bay: string | null
  off: THREE.Color
}

/** Texels per row of the state texture. */
export const LED_TEX_WIDTH = 256

/** The texel alphas: off, lit and blinking, lit steady. */
export const LED_OFF = 0
export const LED_BLINK = 0.5
export const LED_ON = 1

const _v = new THREE.Vector3()

/**
 * The lights merged into one geometry in the copy's frame: positions only
 * (the material is unlit), plus `ledIndex` (which light) and `ledOff` (its
 * dark colour) per vertex. Lights that share a name and bay (one light
 * split across meshes) share an index.
 */
export function buildLedBatch(sources: readonly LedSource[]): {
  geometry: THREE.BufferGeometry
  leds: BatchLed[]
} {
  const leds: BatchLed[] = []
  const indexOf = new Map<string, number>()
  const pos: number[] = []
  const idx: number[] = []
  const off: number[] = []
  const tris: number[] = []
  for (const s of sources) {
    const key = `${s.bay ?? ""}\u0001${s.name}`
    let li = indexOf.get(key)
    if (li === undefined) {
      li = leds.length
      indexOf.set(key, li)
      leds.push({ name: s.name, bay: s.bay })
    }
    const g = s.mesh.geometry
    const p = g.getAttribute("position")
    const base = pos.length / 3
    for (let i = 0; i < p.count; i++) {
      _v.fromBufferAttribute(p, i).applyMatrix4(s.local)
      pos.push(_v.x, _v.y, _v.z)
      idx.push(li)
      off.push(s.off.r, s.off.g, s.off.b)
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) tris.push(base + g.index.getX(i))
    } else {
      for (let i = 0; i < p.count; i++) tris.push(base + i)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute("ledIndex", new THREE.Float32BufferAttribute(idx, 1))
  geometry.setAttribute("ledOff", new THREE.Float32BufferAttribute(off, 3))
  geometry.setIndex(tris)
  geometry.computeBoundingSphere()
  return { geometry, leds }
}

/** The state texture's size for `lights` × `devices` texels. */
export function ledTextureSize(
  lights: number,
  devices: number
): { width: number; height: number } {
  const n = Math.max(1, lights * devices)
  return {
    width: Math.min(n, LED_TEX_WIDTH),
    height: Math.ceil(n / LED_TEX_WIDTH),
  }
}

const _c = new THREE.Color()

/**
 * Each device's lights into `data` (RGBA floats, device after device):
 * the lit colour in the working colour space and LED_ON, LED_BLINK or
 * LED_OFF. `blink` false (a far copy, too small for a blink to read, or
 * prefers-reduced-motion) holds a blinking light steady. Returns whether
 * any light blinks.
 */
export function fillLedStates(
  data: Float32Array,
  leds: readonly BatchLed[],
  devices: readonly (DeviceLeds | null | undefined)[],
  blink: boolean
): boolean {
  let anyBlink = false
  data.fill(0)
  devices.forEach((dev, d) => {
    leds.forEach((led, l) => {
      const look = ledLook(ledStateOf(dev, led.name, led.bay), !blink)
      if (!look.color) return
      const o = (d * leds.length + l) * 4
      _c.set(look.color)
      data[o] = _c.r
      data[o + 1] = _c.g
      data[o + 2] = _c.b
      data[o + 3] = look.blink ? LED_BLINK : LED_ON
      if (look.blink) anyBlink = true
    })
  })
  return anyBlink
}

/** The state texture for `lights` × `devices`, filled by fillLedStates. */
export function ledStateTexture(
  lights: number,
  devices: number
): THREE.DataTexture {
  const { width, height } = ledTextureSize(lights, devices)
  const tex = new THREE.DataTexture(
    new Float32Array(width * height * 4),
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType
  )
  tex.minFilter = THREE.NearestFilter
  tex.magFilter = THREE.NearestFilter
  tex.generateMipmaps = false
  tex.needsUpdate = true
  return tex
}

/**
 * The batch's material: unlit, double sided (flat LEDs wound either way
 * stay visible, as the pack's own material), not tone mapped; each vertex
 * takes its light's look for its instance from `states`.
 */
export function ledBatchMaterial(
  states: THREE.DataTexture,
  lights: number
): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({
    color: "#ffffff",
    toneMapped: false,
    side: THREE.DoubleSide,
  })
  const uniforms = {
    ledStates: { value: states },
    ledCount: { value: lights },
    ledPhase: LED_PHASE,
  }
  mat.userData.ledUniforms = uniforms
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
attribute float ledIndex;
attribute vec3 ledOff;
uniform highp sampler2D ledStates;
uniform int ledCount;
uniform float ledPhase;
varying vec3 vLedColour;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
    int inst = gl_InstanceID;
  #else
    int inst = 0;
  #endif
  int t = inst * ledCount + int(ledIndex + 0.5);
  vec4 st = texelFetch(ledStates, ivec2(t % ${LED_TEX_WIDTH}, t / ${LED_TEX_WIDTH}), 0);
  bool lit = st.a > 0.75 || (st.a > 0.25 && ledPhase > 0.5);
  vLedColour = lit ? st.rgb : ledOff;
}`
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vLedColour;`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
diffuseColor.rgb = vLedColour;`
      )
  }
  mat.customProgramCacheKey = () => "danbyte-led-batch"
  return mat
}
