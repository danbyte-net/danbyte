import { useEffect, useMemo } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import * as THREE from "three"
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js"
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js"
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js"
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js"

import type { V3 } from "@/lib/model-ports"

/**
 * The device viewer's product-shot look (docs/dcim/model-packs.md → How
 * the viewer lights a model): screen-space ambient occlusion over the
 * studio light, so port cages, vents, seams and module gaps read as
 * depth. Only the model viewer has it - the room and its racks stay on
 * plain rendering.
 *
 * Each frame (on demand) the model renders into a multisampled half-float
 * target, three's GTAO darkens its creases, and OutputPass tone maps it
 * onto the canvas with the studio's AgX and exposure. What must keep its
 * exact colour or blend over the result - port markers, bay outlines, lit
 * LEDs, the contact shadow, a ghost - is everything transparent or not
 * tone mapped; it skips the AO and draws after, straight to the canvas,
 * depth-tested against a depth-only pass of the model. Nothing changes for
 * picking: layers are the camera's, never the raycaster's, and only for
 * the length of a frame.
 */

/** localStorage override: "full" or "plain" (testing, a weak GPU that
 * reports itself well). */
export const VIEWER_LOOK_KEY = "danbyte:viewer-look"

/** Renderers that run on the CPU: no screen-space AO there. */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software|basic render driver|mesa offscreen/i

/** Whether a GPU (its unmasked renderer string, when the browser gives
 * it, and its memory in GB, when known) is too weak for the AO pass. */
export function weakGpu(renderer: string, deviceMemoryGb?: number): boolean {
  if (SOFTWARE_RENDERER.test(renderer)) return true
  return deviceMemoryGb !== undefined && deviceMemoryGb < 4
}

/** "full" (AO) or "plain" for this renderer: plain without WebGL 2 or
 * float render targets, on a software renderer or a low-memory device. */
export function viewerLook(gl: THREE.WebGLRenderer): "full" | "plain" {
  try {
    const v = localStorage.getItem(VIEWER_LOOK_KEY)
    if (v === "full" || v === "plain") return v
  } catch {
    // No storage: decide from the GPU.
  }
  const ctx = gl.getContext()
  if (
    typeof WebGL2RenderingContext === "undefined" ||
    !(ctx instanceof WebGL2RenderingContext) ||
    !ctx.getExtension("EXT_color_buffer_float")
  )
    return "plain"
  const info = ctx.getExtension("WEBGL_debug_renderer_info")
  const name = info
    ? String(ctx.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
    : ""
  const mem = (navigator as { deviceMemory?: number }).deviceMemory
  return weakGpu(name, mem) ? "plain" : "full"
}

/** The AO's reach for a model of upright size `size` (m): about a port
 * cage's depth on a 1U switch, growing slowly with the model. */
export function aoRadiusFor(size: V3): number {
  const radius = Math.hypot(...size) / 2
  return Math.min(Math.max(radius * 0.05, 0.008), 0.06)
}

/** How strongly the AO darkens: lighter when the model brings its own
 * baked occlusion, which already darkens its ambient light. */
export const AO_INTENSITY = { screen: 0.85, withBaked: 0.5 }

/** Layers a frame sorts renderables into: the model, through the AO, and
 * the overlay drawn after it. Layer 0 stays on, so other cameras, the
 * contact shadow's and the raycaster see everything as before. */
const MODEL_LAYER = 30
const OVERLAY_LAYER = 31

/** Whether an object draws over the AO'd model: lines, points, sprites and
 * anything transparent or not tone mapped. */
export function isOverlay(o: THREE.Object3D): boolean {
  const any = o as THREE.Object3D & {
    isLine?: boolean
    isPoints?: boolean
    isSprite?: boolean
    material?: THREE.Material | THREE.Material[]
  }
  if (any.isLine || any.isPoints || any.isSprite) return true
  const mats = Array.isArray(any.material)
    ? any.material
    : any.material
      ? [any.material]
      : []
  return mats.some((m) => m.transparent || m.toneMapped === false)
}

/** Whether an object only takes the pointer: every material invisible.
 * Plain rendering skips it; a pass with an override material would not. */
export function isHitOnly(o: THREE.Object3D): boolean {
  const mat = (o as THREE.Object3D & { material?: unknown }).material
  const mats = (Array.isArray(mat) ? mat : mat ? [mat] : []) as THREE.Material[]
  return mats.length > 0 && mats.every((m) => !m.visible)
}

/** Sort the scene's renderables into the model and overlay layers (lights
 * on both); answers whether any overlay is visible. */
function sortLayers(scene: THREE.Scene): boolean {
  let overlay = false
  scene.traverse((o) => {
    const drawn =
      o instanceof THREE.Mesh ||
      o instanceof THREE.Line ||
      o instanceof THREE.Points ||
      o instanceof THREE.Sprite
    if (!drawn) {
      o.layers.enable(MODEL_LAYER)
      o.layers.enable(OVERLAY_LAYER)
      return
    }
    if (isHitOnly(o)) {
      // A pick box: an override material (the AO's normals, the depth
      // pass) would draw it.
      o.layers.disable(MODEL_LAYER)
      o.layers.disable(OVERLAY_LAYER)
      return
    }
    const over = isOverlay(o)
    o.layers.enable(over ? OVERLAY_LAYER : MODEL_LAYER)
    o.layers.disable(over ? MODEL_LAYER : OVERLAY_LAYER)
    if (over && o.visible) overlay = true
  })
  return overlay
}

/** The most pixels the AO is worked out at; a bigger canvas (a 4K
 * fullscreen at 2× is 33 million) gets it at a lower resolution, scaled up
 * in the blend. Occlusion is soft, so it doesn't show. */
export const AO_MAX_PIXELS = 4_000_000

/** The AO's own size for a canvas of `w`×`h` device pixels. */
export function aoSize(w: number, h: number): [number, number] {
  const s = Math.min(1, Math.sqrt(AO_MAX_PIXELS / Math.max(w * h, 1)))
  return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))]
}

/** GTAO at a capped resolution (aoSize). */
class CappedGtaoPass extends GTAOPass {
  setSize(width: number, height: number): void {
    super.setSize(...aoSize(width, height))
  }
}

/** The AO for the viewer's canvas: renders every frame in place of r3f's
 * own render. `intensity` 0 is the plain render through the same path. */
export function ViewerAo({
  radius,
  intensity,
  clip,
}: {
  radius: number
  intensity: number
  /** The model's box: AO is computed inside it only. */
  clip: THREE.Box3
}) {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const width = useThree((s) => s.size.width)
  const height = useThree((s) => s.size.height)
  const dpr = useThree((s) => s.viewport.dpr)
  const invalidate = useThree((s) => s.invalidate)
  // GTAO compiles for the camera's projection: a new camera (a face view's
  // orthographic one) gets a new chain.
  const fx = useMemo(() => {
    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    })
    const composer = new EffectComposer(gl, target)
    const render = new RenderPass(scene, camera)
    const ao = new CappedGtaoPass(scene, camera, 1, 1)
    ao.output = GTAOPass.OUTPUT.Default
    const output = new OutputPass()
    composer.addPass(render)
    composer.addPass(ao)
    composer.addPass(output)
    const depthOnly = new THREE.MeshBasicMaterial({ colorWrite: false })
    return { composer, ao, passes: [render, ao, output], depthOnly }
  }, [gl, scene, camera])
  useEffect(
    () => () => {
      fx.passes.forEach((p) => p.dispose())
      fx.composer.dispose()
      fx.depthOnly.dispose()
    },
    [fx]
  )
  useEffect(() => {
    fx.composer.setPixelRatio(dpr)
    fx.composer.setSize(width, height)
    invalidate()
  }, [fx, width, height, dpr, invalidate])
  useEffect(() => {
    fx.ao.updateGtaoMaterial({
      radius,
      distanceExponent: 1.5,
      thickness: 1,
      scale: 1,
      samples: 16,
    })
    fx.ao.updatePdMaterial({ radius: 6, samples: 16, rings: 2 })
    fx.ao.blendIntensity = intensity
    fx.ao.enabled = intensity > 0
    const box = clip.clone().expandByScalar(radius)
    fx.ao.setSceneClipBox(box)
    invalidate()
  }, [fx, radius, intensity, clip, invalidate])

  useFrame(() => {
    const overlay = sortLayers(scene)
    const mask = camera.layers.mask
    const autoClear = gl.autoClear
    const autoShadow = gl.shadowMap.autoUpdate
    try {
      // The shadow map once per frame, not once per pass.
      gl.shadowMap.autoUpdate = false
      gl.shadowMap.needsUpdate = true
      camera.layers.set(MODEL_LAYER)
      fx.composer.render()
      if (!overlay) return
      // The overlay over the tone-mapped result, hidden where the model
      // stands in front of it.
      gl.autoClear = false
      gl.setRenderTarget(null)
      gl.clearDepth()
      scene.overrideMaterial = fx.depthOnly
      gl.render(scene, camera)
      scene.overrideMaterial = null
      camera.layers.set(OVERLAY_LAYER)
      gl.render(scene, camera)
    } finally {
      scene.overrideMaterial = null
      camera.layers.mask = mask
      gl.autoClear = autoClear
      gl.shadowMap.autoUpdate = autoShadow
    }
  }, 1)
  return null
}
