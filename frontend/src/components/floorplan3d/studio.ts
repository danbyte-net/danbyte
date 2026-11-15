import * as THREE from "three"

import type {
  ImagePortMarker,
  Model3DFit,
  Model3DFront,
  Model3DUp,
  ModelBay,
  ModelEmptyMode,
} from "@/lib/api"
import { parseAnchor } from "@/lib/model-assembly"
import {
  FACE_WIDTH_PX,
  ISO_DIRECTION,
  ISO_SIZE_PX,
  faceFrame,
  faceImagePx,
  fitWindow,
  imageLedsFromBoxes,
  imagePortsFromAnchors,
  ledSource,
  openingFromExtras,
} from "@/lib/model-studio"
import type {
  Face,
  FaceFrame,
  ImageLeds,
  LedBox,
  PortAnchor,
  V3,
} from "@/lib/model-studio"

import { acquireModel, fittedModel, releaseModel } from "./device-model"
import type { ModelEntry } from "./device-model"
import { assembleModel } from "./model-assembly"
import { modelTargetM } from "./world"

/**
 * The studio: a device type's (or a device's) assembled model rendered
 * offscreen into rack-face images and a ¾ view (docs/dcim/model-packs.md).
 *
 * The same loader and cache as the room (device-model), the same assembly
 * (model-assembly) and fit (`fittedModel`), and the same light as the model
 * viewers (`studioEnvironment` + `STUDIO_LIGHTS`). The faces use
 * orthographic cameras fitted to the face frame - the rack face by the
 * type's rack units - so an image fills its rack slot exactly; the ports
 * and LEDs are projected with the same frame (lib/model-studio).
 */

/** One emissive panel of the studio environment: a softbox, strip or
 * bounce card standing in the environment's unit room, facing its centre
 * (what drei's `<Lightformer>` is - a plane of colour times intensity).
 * Only reflections and image light see it. */
export interface StudioPanel {
  position: V3
  /** Width and height. */
  size: [number, number]
  /** Linear radiance: the colour times this. */
  intensity: number
  color?: string
}

/**
 * The model viewers' and the studio's light, the one source of truth for
 * both: AgX tone mapping (Blender's default view) at `exposure`; a
 * procedural photo-studio environment - a soft gray world lit by `panels`
 * (a softbox key over the front right, a fill card left, a low rim strip
 * behind, a top light, a broad dim card facing the front and a floor
 * bounce) - at `environment` strength, which is what metal reflects; a
 * low ambient; one key light from the front right and a dim fill.
 *
 * Right and left are the viewer's, facing the front (−Z): the key stands
 * at −X, across from the three-quarter camera (+X), so a glossy lid or a
 * cage top does not mirror the key straight back into that view.
 *
 * Mirror-flat silver (cages, shields) shows whatever it faces: straight
 * on, the dim front card, so a face reads mid gray rather than black or
 * white; from above, the low rim lies below the reflected angle, so cage
 * tops do not flare white.
 *
 * The 3D room (stage) keeps its own: ACES and three's RoomEnvironment,
 * tuned for walls, floors and racks.
 */
export const STUDIO_LIGHTS = {
  toneMapping: THREE.AgXToneMapping as THREE.ToneMapping,
  exposure: 1.35,
  /** The environment's world colour (linear gray). */
  world: 0.06,
  environment: 0.8,
  panels: [
    { position: [-3, 3.5, -4], size: [3.5, 2.5], intensity: 5 },
    { position: [5, 1.5, -1.5], size: [2.5, 3], intensity: 1.4 },
    { position: [0, 0.8, 6], size: [7, 0.6], intensity: 3 },
    { position: [0, 5, 0.5], size: [4, 3], intensity: 1.8 },
    { position: [0, 0, -6], size: [9, 3], intensity: 0.4 },
    { position: [0, -4, 0], size: [8, 8], intensity: 0.15 },
  ] as StudioPanel[],
  ambient: 0.12,
  key: { position: [-2.5, 4, -3] as V3, intensity: 1.6 },
  fill: { position: [2, 1, 3] as V3, intensity: 0.35 },
  /** The soft ground shadow under a three-quarter view. */
  shadow: { opacity: 0.45 },
}

/** The studio environment as a scene to bake: the gray world and the
 * panels, each facing the centre. `dispose` frees its geometry and
 * materials. Built from planes only: no files, airgap- and CSP-safe. */
export function studioEnvironmentScene(
  lights: Pick<typeof STUDIO_LIGHTS, "world" | "panels"> = STUDIO_LIGHTS
): { scene: THREE.Scene; dispose: () => void } {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color().setScalar(lights.world)
  const plane = new THREE.PlaneGeometry(1, 1)
  const materials: THREE.Material[] = []
  for (const p of lights.panels) {
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(p.color ?? 0xffffff).multiplyScalar(p.intensity),
      side: THREE.DoubleSide,
      toneMapped: false,
    })
    materials.push(material)
    const mesh = new THREE.Mesh(plane, material)
    mesh.position.set(...p.position)
    mesh.scale.set(p.size[0], p.size[1], 1)
    mesh.lookAt(0, 0, 0)
    scene.add(mesh)
  }
  return {
    scene,
    dispose: () => {
      plane.dispose()
      materials.forEach((m) => m.dispose())
    },
  }
}

/** The studio environment baked for `gl`: the model viewers and the
 * studio share it. */
export function studioEnvironment(gl: THREE.WebGLRenderer): {
  texture: THREE.Texture
  dispose: () => void
} {
  const pmrem = new THREE.PMREMGenerator(gl)
  const env = studioEnvironmentScene()
  const rt = pmrem.fromScene(env.scene, 0.02, 0.1, 20)
  env.dispose()
  return {
    texture: rt.texture,
    dispose: () => {
      rt.dispose()
      pmrem.dispose()
    },
  }
}

export interface StudioSource {
  model: {
    url: string
    fit: Model3DFit
    up: Model3DUp
    front: Model3DFront
    empty_mode?: ModelEmptyMode
  }
  size_mm: {
    width_mm: number | null
    height_mm: number | null
    depth_mm: number | null
  }
  /** `[width, height or null]` of the face frame, from the server. */
  frame_mm: [number, number | null]
  /** Bays and what each shows: a part, else its cover. */
  bays: readonly ModelBay[]
  /** The chassis model's `leds:` bindings. */
  leds: Record<string, { source?: string }>
  /** Each bay's module `leds:` bindings. */
  bay_leds: Record<string, Record<string, { source?: string }>>
  /** Components by name: `[kind, type]`. */
  ports: Record<string, [string, string]>
}

export interface StudioResult {
  front: Blob
  rear: Blob
  iso: Blob
  imagePorts: { front: ImagePortMarker[]; rear: ImagePortMarker[] }
  imageLeds: ImageLeds
  frame: FaceFrame
  /** Ports whose names match no component (placed as interfaces). */
  unknownPorts: string[]
  /** Ports and LEDs on neither face. */
  offFace: string[]
}

const SUPERSAMPLE = 2

/** Passes per still: each moves the key across its softbox and the sky
 * light across the sky; their mean is soft shadow and contact shading. */
export const STUDIO_PASSES = 32
/** The key's spread, as a share of its distance: the softbox's size. */
const KEY_SPREAD = 0.25
/** The sky light: what the passes' hemisphere adds over the viewer's
 * ambient, and what casts the contact shading. */
const SKY_INTENSITY = 0.5
/** The sky's reach as sin² of its widest angle off vertical: 45°. */
export const SKY_CAP = 0.5

/** The radical inverse in base 2 (Hammersley's second coordinate). */
function radicalInverse(i: number): number {
  let bits = i >>> 0
  bits = ((bits << 16) | (bits >>> 16)) >>> 0
  bits = (((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)) >>> 0
  bits = (((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)) >>> 0
  bits = (((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)) >>> 0
  bits = (((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)) >>> 0
  return bits / 0x100000000
}

/**
 * Pass `i` of `n`, deterministic: where the key stands on its softbox -
 * an offset in the unit disc (a golden-angle spiral) - and the sky
 * light's direction, a unit vector over the sky (SKY_CAP), cosine-weighted
 * so more passes come from overhead.
 */
export function studioPass(
  i: number,
  n: number
): { key: [number, number]; sky: V3 } {
  const u = (i + 0.5) / n
  const r = Math.sqrt(u)
  const a = i * Math.PI * (3 - Math.sqrt(5))
  // The sky stops SKY_CAP short of the horizon: a low light would throw
  // shadows far across the ground.
  const su = u * SKY_CAP
  const s = Math.sqrt(su)
  const phi = 2 * Math.PI * radicalInverse(i)
  return {
    key: [r * Math.cos(a), r * Math.sin(a)],
    sky: [s * Math.cos(phi), Math.sqrt(1 - su), s * Math.sin(phi)],
  }
}

const QUAD_VERTEX =
  "varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }"
const ADD_FRAGMENT =
  "uniform sampler2D map; uniform float weight; varying vec2 vUv; void main() { gl_FragColor = texture2D(map, vUv) * weight; }"

/**
 * Many renders of one view, averaged on the GPU in a half-float target,
 * then tone mapped once onto the canvas - progressive accumulation, the
 * way drei's AccumulativeShadows builds its soft shadows. The passes
 * render linear and premultiplied; the canvas is premultiplied too, so a
 * transparent background stays transparent.
 */
class Accumulator {
  private pass: THREE.WebGLRenderTarget
  private sum: THREE.WebGLRenderTarget
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private quad = new THREE.PlaneGeometry(2, 2)
  private add: THREE.ShaderMaterial
  private out: THREE.MeshBasicMaterial
  private addMesh: THREE.Mesh
  private outMesh: THREE.Mesh
  private renderer: THREE.WebGLRenderer

  constructor(renderer: THREE.WebGLRenderer) {
    this.renderer = renderer
    this.pass = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    })
    this.sum = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
    })
    this.add = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.pass.texture }, weight: { value: 1 } },
      vertexShader: QUAD_VERTEX,
      fragmentShader: ADD_FRAGMENT,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    })
    this.out = new THREE.MeshBasicMaterial({
      map: this.sum.texture,
      blending: THREE.NoBlending,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
    this.addMesh = new THREE.Mesh(this.quad, this.add)
    this.outMesh = new THREE.Mesh(this.quad, this.out)
    this.addMesh.frustumCulled = false
    this.outMesh.frustumCulled = false
  }

  /** Render `scene` from `camera` `passes` times at w×h, `before(i)`
   * moving the lights, and leave the mean, tone mapped, on the canvas. */
  render(
    scene: THREE.Scene,
    camera: THREE.Camera,
    w: number,
    h: number,
    passes: number,
    before: (i: number) => void
  ): void {
    const r = this.renderer
    r.setSize(w, h, false)
    this.pass.setSize(w, h)
    this.sum.setSize(w, h)
    r.setClearColor(0x000000, 0)
    // Cleared by hand: an automatic clear would wipe the sum every pass.
    const autoClear = r.autoClear
    r.autoClear = false
    try {
      r.setRenderTarget(this.sum)
      r.clear()
      this.add.uniforms.weight.value = 1 / passes
      for (let i = 0; i < passes; i++) {
        before(i)
        r.setRenderTarget(this.pass)
        r.clear()
        r.render(scene, camera)
        r.setRenderTarget(this.sum)
        r.render(this.addMesh, this.camera)
      }
      r.setRenderTarget(null)
      r.clear()
      r.render(this.outMesh, this.camera)
    } finally {
      r.autoClear = autoClear
    }
  }

  dispose(): void {
    this.pass.dispose()
    this.sum.dispose()
    this.add.dispose()
    this.out.dispose()
    this.quad.dispose()
  }
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) =>
        b ? resolve(b) : reject(new Error("The image could not be encoded.")),
      "image/webp",
      0.92
    )
  )
}

/** The rendered canvas, scaled down to `w`×`h` (the supersampling). */
async function encode(
  source: HTMLCanvasElement,
  w: number,
  h: number
): Promise<Blob> {
  const out = document.createElement("canvas")
  out.width = w
  out.height = h
  const ctx = out.getContext("2d")
  if (!ctx) throw new Error("No 2D canvas.")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(source, 0, 0, w, h)
  return toBlob(out)
}

function vec(v: THREE.Vector3): V3 {
  return [v.x, v.y, v.z]
}

/** Every `port:` anchor and `led:` node in the placed model, in the room
 * frame. Module copies carry their bay in `userData.danbyteBay`. */
function collect(root: THREE.Object3D): {
  ports: PortAnchor[]
  leds: LedBox[]
} {
  const ports: PortAnchor[] = []
  const leds: LedBox[] = []
  const up = new THREE.Vector3()
  const across = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const p = new THREE.Vector3()
  const visit = (o: THREE.Object3D, bay: string | undefined) => {
    if (!o.visible) return
    const here =
      typeof o.userData.danbyteBay === "string" ? o.userData.danbyteBay : bay
    const a = parseAnchor(o.userData.gltfName)
    if (a?.kind === "port") {
      o.getWorldPosition(p)
      // A port's local +Y points out of it (api.model_anchors).
      up.set(0, 1, 0).transformDirection(o.matrixWorld)
      const anchor: PortAnchor = { name: a.name, p: vec(p), n: vec(up) }
      // The loader keeps a node's glTF extras in userData: the opening's
      // exact size (export spec v1.4), in the empty's frame - its parents'
      // scale (the fit included) carries it into room metres, its own not.
      const op = openingFromExtras(o.userData)
      if (op) {
        o.getWorldScale(scale)
        const sx = Math.abs(scale.x / (o.scale.x || 1))
        const sz = Math.abs(scale.z / (o.scale.z || 1))
        across.set(1, 0, 0).transformDirection(o.matrixWorld)
        anchor.size = [op.w * sx, op.h * sz]
        anchor.u = vec(across)
      }
      ports.push(anchor)
    } else if (a?.kind === "led") {
      const box = new THREE.Box3().setFromObject(o)
      if (!box.isEmpty())
        leds.push({
          id: a.name,
          ...(here ? { bay: here } : {}),
          min: vec(box.min),
          max: vec(box.max),
        })
    }
    for (const c of o.children) visit(c, here)
  }
  visit(root, undefined)
  return { ports, leds }
}

/**
 * Render `src`: its chassis with the parts in `bays`, covers elsewhere.
 * Throws when the model does not load or WebGL is not available.
 */
export async function renderStudio(src: StudioSource): Promise<StudioResult> {
  const urls = [
    src.model.url,
    ...src.bays.filter((b) => b.part).map((b) => b.part!.url),
  ]
  const entries = await Promise.all(urls.map((u) => acquireModel(u)))
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  })
  // The viewers' tone mapping and exposure (STUDIO_LIGHTS).
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = STUDIO_LIGHTS.toneMapping
  renderer.toneMappingExposure = STUDIO_LIGHTS.exposure
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)
  const env = studioEnvironment(renderer)
  const acc = new Accumulator(renderer)
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.ShadowMaterial({ opacity: STUDIO_LIGHTS.shadow.opacity })
  )
  try {
    const chassis = entries[0]
    if (chassis.status !== "ready" || !chassis.scene || !chassis.box)
      throw new Error("The model could not be loaded.")
    const parts: { bay: string; position: string; scene: THREE.Object3D }[] = []
    for (const b of src.bays) {
      if (!b.part) continue
      const e: ModelEntry = entries[urls.indexOf(b.part.url)]
      if (e.status === "ready" && e.scene)
        parts.push({ bay: b.name, position: b.position, scene: e.scene })
    }
    const { root } = assembleModel(
      chassis.scene,
      parts,
      src.bays.length ? src.bays : null,
      src.model.empty_mode ?? "filler"
    )
    // The assembled copy is this render's own: it casts and takes the
    // passes' shadows.
    root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = true
        o.receiveShadow = true
      }
    })
    const fit = fittedModel(chassis.box, src.model, modelTargetM(src.size_mm))
    const placed = new THREE.Group()
    placed.position.set(...fit.position)
    placed.scale.setScalar(fit.scale)
    const turned = new THREE.Group()
    turned.rotation.copy(fit.rotation)
    turned.add(root)
    placed.add(turned)

    const scene = new THREE.Scene()
    scene.environment = env.texture
    scene.environmentIntensity = STUDIO_LIGHTS.environment
    scene.add(placed)
    scene.add(new THREE.AmbientLight(0xffffff, STUDIO_LIGHTS.ambient))
    const key = new THREE.DirectionalLight(
      0xffffff,
      STUDIO_LIGHTS.key.intensity
    )
    const sky = new THREE.DirectionalLight(0xffffff, SKY_INTENSITY)
    const fill = new THREE.DirectionalLight(
      0xffffff,
      STUDIO_LIGHTS.fill.intensity
    )
    for (const l of [key, sky, fill]) {
      scene.add(l)
      scene.add(l.target)
    }
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(placed)
    const size = box.getSize(new THREE.Vector3())
    const centre = box.getCenter(new THREE.Vector3())
    const frame = faceFrame(src.frame_mm, size.y)
    const depth = Math.max(size.z, 1e-3)
    const radius = Math.max(size.length(), 1e-3)

    // Both shadow lights aim at the model's middle, their frusta fitted to
    // it and the ground around it.
    for (const l of [key, sky]) {
      l.castShadow = true
      l.target.position.copy(centre)
      l.target.updateMatrixWorld()
      l.shadow.mapSize.set(2048, 2048)
      Object.assign(l.shadow.camera, {
        left: -radius,
        right: radius,
        top: radius,
        bottom: -radius,
        near: radius * 0.01,
        far: radius * 6,
      })
      l.shadow.camera.updateProjectionMatrix()
      l.shadow.bias = -0.0002
      l.shadow.normalBias = radius * 0.002
    }
    fill.target.position.copy(centre)
    fill.target.updateMatrixWorld()
    // The ground: only its shadow shows, and only under the ¾ view.
    ground.rotation.x = -Math.PI / 2
    ground.position.set(centre.x, box.min.y - radius * 1e-4, centre.z)
    ground.scale.setScalar(radius * 3)
    ground.receiveShadow = true
    ground.visible = false
    scene.add(ground)

    /** Pass `i`: the key across its softbox around `keyAt` (a direction
     * from the middle), the sky light over the hemisphere. */
    const light = (i: number, keyAt: V3, fillAt: V3) => {
      const { key: k, sky: s } = studioPass(i, STUDIO_PASSES)
      const dir = new THREE.Vector3(...keyAt).normalize()
      const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize()
      const up = dir.clone().cross(side).normalize()
      dir
        .addScaledVector(side, k[0] * KEY_SPREAD)
        .addScaledVector(up, k[1] * KEY_SPREAD)
        .normalize()
      key.position.copy(centre).addScaledVector(dir, radius * 3)
      sky.position
        .copy(centre)
        .addScaledVector(new THREE.Vector3(...s), radius * 3)
      fill.position.copy(centre).add(new THREE.Vector3(...fillAt))
      for (const l of [key, sky, fill]) l.updateMatrixWorld()
    }

    const shoot = async (face: Face) => {
      const [w, h] = faceImagePx(frame, FACE_WIDTH_PX)
      const cam = new THREE.OrthographicCamera(
        -frame.w / 2,
        frame.w / 2,
        frame.h,
        0,
        0.001,
        depth * 4 + 1
      )
      // The rear camera stands behind and looks forward; its left/right
      // are the room's +X/−X, as projectToFace has them.
      const z = face === "front" ? box.min.z - depth : box.max.z + depth
      cam.position.set(0, 0, z)
      cam.up.set(0, 1, 0)
      cam.lookAt(0, 0, face === "front" ? z + 1 : z - 1)
      cam.updateMatrixWorld(true)
      const turn = ([px, py, pz]: V3): V3 => [
        px,
        py,
        face === "front" ? pz : -pz,
      ]
      const keyAt = turn(STUDIO_LIGHTS.key.position)
      const fillAt = turn(STUDIO_LIGHTS.fill.position)
      acc.render(
        scene,
        cam,
        w * SUPERSAMPLE,
        h * SUPERSAMPLE,
        STUDIO_PASSES,
        (i) => light(i, keyAt, fillAt)
      )
      return encode(renderer.domElement, w, h)
    }

    // The faces: no ground - they drop into a rack slot as they are.
    const front = await shoot("front")
    const rear = await shoot("rear")

    // The ¾ view: orthographic, fitted to the model's box from the 3D
    // card's angle, with room for its shadow on the ground.
    const [iw, ih] = ISO_SIZE_PX
    const dir = new THREE.Vector3(...ISO_DIRECTION).normalize()
    const iso = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, radius * 4)
    iso.position.copy(centre).addScaledVector(dir, radius * 2)
    iso.lookAt(centre)
    iso.updateMatrixWorld(true)
    const inv = iso.matrixWorldInverse
    const corners: V3[] = []
    for (const x of [box.min.x, box.max.x])
      for (const y of [box.min.y, box.max.y])
        for (const z of [box.min.z, box.max.z])
          corners.push(vec(new THREE.Vector3(x, y, z).applyMatrix4(inv)))
    const m = Math.max(size.x, size.z) * 0.04
    for (const x of [box.min.x - m, box.max.x + m])
      for (const z of [box.min.z - m, box.max.z + m])
        corners.push(vec(new THREE.Vector3(x, box.min.y, z).applyMatrix4(inv)))
    const [l, r, t, b] = fitWindow(corners, iw / ih)
    Object.assign(iso, { left: l, right: r, top: t, bottom: b })
    iso.updateProjectionMatrix()
    ground.visible = true
    acc.render(
      scene,
      iso,
      iw * SUPERSAMPLE,
      ih * SUPERSAMPLE,
      STUDIO_PASSES,
      (i) => light(i, STUDIO_LIGHTS.key.position, STUDIO_LIGHTS.fill.position)
    )
    const isoBlob = await encode(renderer.domElement, iw, ih)
    ground.visible = false

    // Ports and LEDs, projected with the faces' frame.
    const found = collect(placed)
    const ports = imagePortsFromAnchors(found.ports, src.ports, frame)
    const leds = imageLedsFromBoxes(
      found.leds,
      (led) =>
        led.bay
          ? ledSource(led.id, src.bay_leds[led.bay])
          : ledSource(led.id, src.leds),
      frame,
      depth
    )
    return {
      front,
      rear,
      iso: isoBlob,
      imagePorts: ports.doc,
      imageLeds: leds.doc,
      frame,
      unknownPorts: ports.unknown,
      offFace: [...ports.offFace, ...leds.offFace],
    }
  } finally {
    ground.geometry.dispose()
    ground.material.dispose()
    acc.dispose()
    env.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    urls.forEach((u) => releaseModel(u))
  }
}
