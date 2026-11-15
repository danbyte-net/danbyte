import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

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

/** The viewers' and the studio's light: the 3D room's (stage) - the
 * environment at the room's strength, ambient, one key light from the
 * front and a dim fill. At full environment strength shiny parts (port
 * cages) read near white. */
export const STUDIO_LIGHTS = {
  environment: 0.35,
  ambient: 0.4,
  key: { position: [2, 4, -3] as V3, intensity: 0.95 },
  fill: { position: [-2, 1, 3] as V3, intensity: 0.25 },
}

/** Studio light from three's procedural room: no files, airgap-safe. The
 * model viewers and the studio share it. */
export function studioEnvironment(gl: THREE.WebGLRenderer): {
  texture: THREE.Texture
  dispose: () => void
} {
  const pmrem = new THREE.PMREMGenerator(gl)
  const rt = pmrem.fromScene(new RoomEnvironment(), 0.04)
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
  // What the room's canvas uses (react-three-fiber's defaults).
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.setClearColor(0x000000, 0)
  renderer.setPixelRatio(1)
  const env = studioEnvironment(renderer)
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
    scene.add(key)
    scene.add(key.target)
    const fill = new THREE.DirectionalLight(
      0xffffff,
      STUDIO_LIGHTS.fill.intensity
    )
    scene.add(fill)
    scene.add(fill.target)
    scene.updateMatrixWorld(true)

    const box = new THREE.Box3().setFromObject(placed)
    const size = box.getSize(new THREE.Vector3())
    const frame = faceFrame(src.frame_mm, size.y)
    const depth = Math.max(size.z, 1e-3)

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
      const [kx, ky, kz] = STUDIO_LIGHTS.key.position
      key.position.set(kx, ky, face === "front" ? kz : -kz)
      const [fx, fy, fz] = STUDIO_LIGHTS.fill.position
      fill.position.set(fx, fy, face === "front" ? fz : -fz)
      renderer.setSize(w * SUPERSAMPLE, h * SUPERSAMPLE, false)
      renderer.render(scene, cam)
      return encode(renderer.domElement, w, h)
    }

    const front = await shoot("front")
    const rear = await shoot("rear")

    // The ¾ view: orthographic, fitted to the model's box from the 3D
    // card's angle.
    const [iw, ih] = ISO_SIZE_PX
    const centre = box.getCenter(new THREE.Vector3())
    const dir = new THREE.Vector3(...ISO_DIRECTION).normalize()
    const radius = Math.max(size.length(), 1e-3)
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
    const [l, r, t, b] = fitWindow(corners, iw / ih)
    Object.assign(iso, { left: l, right: r, top: t, bottom: b })
    iso.updateProjectionMatrix()
    key.position.set(...STUDIO_LIGHTS.key.position)
    fill.position.set(...STUDIO_LIGHTS.fill.position)
    renderer.setSize(iw * SUPERSAMPLE, ih * SUPERSAMPLE, false)
    renderer.render(scene, iso)
    const isoBlob = await encode(renderer.domElement, iw, ih)

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
    env.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    urls.forEach((u) => releaseModel(u))
  }
}
