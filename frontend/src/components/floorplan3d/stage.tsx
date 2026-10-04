import { useEffect, useMemo } from "react"
import type { ComponentProps, MutableRefObject, ReactNode } from "react"
import { Canvas, useThree } from "@react-three/fiber"
import { EffectComposer, N8AO } from "@react-three/postprocessing"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"
import { toast } from "sonner"

import { detectRenderQuality, storedQualitySetting } from "@/lib/render-quality"
import type { RenderQuality } from "@/lib/render-quality"
import { cn } from "@/lib/utils"

import { CameraRig } from "./camera-rig"

/**
 * The stage every 3D view in this folder stands on - the room, one rack,
 * one cabinet: the canvas, its light rig, the effects the quality tier
 * pays for, the camera rig, and the bridges DOM controls use to reach into
 * a canvas that only draws on demand.
 *
 * The frameloop is `demand`: nothing draws until something asks. Every
 * change that only a ref sees, or that only takes children away, has to
 * kick a frame itself - a missed `invalidate()` leaves the old picture on
 * screen. `stamp` is the blanket for view toggles: any change to it draws
 * one frame.
 */

/** Where the stage's lights stand, metres. */
export interface LightRig {
  /** The shadow-casting key light, and the point it aims at. */
  key: [number, number, number]
  target: [number, number, number]
  /** Half the side of the key's square shadow frustum, and its far plane. */
  frustum: number
  far: number
  /** The dim fill light. */
  fill: [number, number, number]
}

/** The room's rig, fitted to a floor from (0, 0) to (w, d): the key high
 * over the front-left quarter and aimed at the middle, its shadow frustum
 * covering the whole floor; the fill from the far corner. */
export function roomLights(w: number, d: number, diag: number): LightRig {
  return {
    key: [w * 0.25, Math.max(10, diag * 0.6), d * 0.15],
    target: [w / 2, 0, d / 2],
    frustum: diag * 0.75 + 5,
    far: diag * 2 + 40,
    fill: [w, 8, d],
  }
}

/** The rig for one object standing at the origin with its front to −Z,
 * `size` metres at its largest: the key above and in front of it, off to
 * the viewer's right (−x), so the face it is looked at from catches light
 * and a cabinet door swung open to the left throws no shadow inside; the
 * shadow frustum fitted to the object rather than to a room. */
export function objectLights(size: number): LightRig {
  const s = Math.max(size, 0.5)
  return {
    key: [-s * 1.2, s * 2.4 + 1, -s * 2],
    target: [0, s * 0.4, 0],
    frustum: s * 1.5,
    far: s * 8 + 10,
    fill: [s * 2, s * 2 + 2, s * 2],
  }
}

/** The view as a PNG data URL, drawn over `background` (transparent when
 * left out); null when there is no canvas to read. */
export type StageCapture = (background?: string) => string | null

/** The quality tier an embedded view draws at: the one picked in the room's
 * View menu on this device, Auto resolved by probing the GPU. */
export function storedRenderQuality(): RenderQuality {
  const setting = storedQualitySetting()
  return setting === "auto" ? detectRenderQuality() : setting
}

export function Stage({
  quality,
  camera,
  lights,
  controls,
  stamp = "",
  invalidateRef,
  captureRef,
  onPointerMissed,
  children,
}: {
  /** Effects budget: Low = no shadows or AO and a capped pixel ratio,
   * Medium = shadows, High = shadows and ambient occlusion, Flat = one
   * ambient light and nothing else. */
  quality: RenderQuality
  /** The camera's first placement; the rig owns it from there. */
  camera: {
    position: [number, number, number]
    fov?: number
    near?: number
    far: number
  }
  lights: LightRig
  /** The orbit/fly rig - see `CameraRig`. */
  controls: ComponentProps<typeof CameraRig>
  /** Any change draws one frame - pass every view toggle in it. */
  stamp?: string
  /** Filled with the canvas's `invalidate()` for DOM controls. */
  invalidateRef?: MutableRefObject<(() => void) | null>
  /** Filled with a PNG reader for an export button. */
  captureRef?: MutableRefObject<StageCapture | null>
  onPointerMissed?: () => void
  children: ReactNode
}) {
  return (
    <Canvas
      frameloop="demand"
      // `shadows` costs nothing until a light casts - the quality tier
      // gates that per light, so Low never pays the shadow pass.
      shadows
      // Render at the display's real pixel ratio (capped at 2): 1.75 left a
      // HiDPI canvas rendering below native and reading softer than the 2D
      // faceplate beside it. Low quality caps at 1.5 instead.
      dpr={quality === "low" || quality === "flat" ? [1, 1.5] : [1, 2]}
      camera={{
        fov: 45,
        // Initial only - CameraRig re-fits `near` per frame to the orbit
        // distance (1 cm nose-on, 0.5 m across the hall).
        near: 0.05,
        ...camera,
      }}
      onPointerMissed={onPointerMissed}
    >
      {invalidateRef && <InvalidatorBridge apiRef={invalidateRef} />}
      <InvalidateOnToggle stamp={stamp} />
      {captureRef && <CaptureBridge captureRef={captureRef} />}
      {/* Light rig: soft ambient + one shadow-casting key light + a dim
          fill, over a procedural studio environment (PMREM'd
          RoomEnvironment - zero assets, so airgap/CSP-safe). Intensities
          re-balanced for the environment's contribution; tone mapping is
          r3f's default ACESFilmic (that's why photo faceplates opt out
          with toneMapped={false}). */}
      {/* Flat: ONE full-strength ambient and nothing else - no key light,
          no shadow pass, no environment probe. Standard materials still
          shade, they just have a single uniform light to answer to, which
          is the cheapest honest way to take the light rig out of the
          picture. */}
      <ambientLight intensity={quality === "flat" ? 1.15 : 0.4} />
      {quality !== "flat" && (
        <>
          <KeyLight
            rig={lights}
            castShadow={quality !== "low"}
            shadowRes={quality === "high" ? 2048 : 1024}
          />
          <directionalLight position={lights.fill} intensity={0.25} />
          <StudioEnvironment />
        </>
      )}
      {/* Ambient occlusion (High only): the interior depth that makes an
          open cabinet look deep rather than printed. Screen-space, so the
          depthWrite=false ghosts never smudge it. */}
      {quality === "high" && (
        <EffectComposer multisampling={4}>
          {/* Contact shading, not a black wash. intensity 3 (triple the
              default) buried every large dark surface: the zinc walls went
              solid black on High and read as having disappeared. */}
          <N8AO
            aoRadius={0.4}
            intensity={1.1}
            distanceFalloff={0.6}
            quality="performance"
            halfRes
          />
        </EffectComposer>
      )}
      {children}
      {/* Last, so every object's own frame callback reads the camera before
          the rig moves it. */}
      <CameraRig {...controls} />
    </Canvas>
  )
}

/**
 * The shadow-casting key light with an orthographic frustum fitted by the
 * rig - one shadow pass, paid only on frames the demand loop already
 * renders. Keyed by its shadow config so a quality change rebuilds the map
 * cleanly instead of resizing it in place.
 */
function KeyLight({
  rig,
  castShadow,
  shadowRes,
}: {
  rig: LightRig
  castShadow: boolean
  shadowRes: number
}) {
  const target = useMemo(() => new THREE.Object3D(), [])
  const { frustum } = rig
  return (
    <>
      <primitive object={target} position={rig.target} />
      <directionalLight
        key={`${castShadow}-${shadowRes}`}
        position={rig.key}
        intensity={0.95}
        target={target}
        castShadow={castShadow}
        shadow-mapSize-width={shadowRes}
        shadow-mapSize-height={shadowRes}
        // Bias pair against acne on the big flat slab without peter-panning
        // the rack feet off the floor.
        shadow-bias={-0.0003}
        shadow-normalBias={0.03}
        shadow-camera-near={1}
        shadow-camera-far={rig.far}
        shadow-camera-left={-frustum}
        shadow-camera-right={frustum}
        shadow-camera-top={frustum}
        shadow-camera-bottom={-frustum}
      />
    </>
  )
}

/**
 * Procedural studio IBL: three's RoomEnvironment baked through PMREM once
 * per mount. Zero external assets (no HDRI fetch - CSP/airgap-safe), and it
 * is what gives painted steel and rails something to reflect; without an
 * environment, metalness only darkens.
 */
function StudioEnvironment() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    const pmrem = new THREE.PMREMGenerator(gl)
    const rt = pmrem.fromScene(new RoomEnvironment(), 0.04)
    pmrem.dispose()
    scene.environment = rt.texture
    scene.environmentIntensity = 0.35
    invalidate()
    return () => {
      scene.environment = null
      rt.dispose()
    }
  }, [gl, scene, invalidate])
  return null
}

/** fiber 9.6.1 never invalidates on child REMOVAL (removeChild nulls the
 * parent before invalidateInstance's parent guard runs), so toggling a layer
 * OFF would leave its last frame on screen until the next orbit. One kicked
 * frame per view-pref change closes that whole class. */
export function InvalidateOnToggle({ stamp }: { stamp: string }) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate()
  }, [stamp, invalidate])
  return null
}

/** invalidate() escape hatch for DOM overlays: with `frameloop="demand"`, a
 * HUD button that mutates a ref (fly-to) must kick a frame itself. */
function InvalidatorBridge({
  apiRef,
}: {
  apiRef: MutableRefObject<(() => void) | null>
}) {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    apiRef.current = invalidate
    return () => {
      apiRef.current = null
    }
  }, [apiRef, invalidate])
  return null
}

/**
 * The PNG reader. It draws a fresh frame - every object's frame callback
 * and the effects pass included - and reads the canvas back in the same
 * task: the drawing buffer is only cleared once the browser composites, so
 * the read needs no `preserveDrawingBuffer`, and the room pays nothing for
 * it on every other frame.
 */
function CaptureBridge({
  captureRef,
}: {
  captureRef: MutableRefObject<StageCapture | null>
}) {
  const gl = useThree((s) => s.gl)
  const advance = useThree((s) => s.advance)
  useEffect(() => {
    captureRef.current = (background) => {
      advance(performance.now(), true)
      const src = gl.domElement
      if (!background) return src.toDataURL("image/png")
      const out = document.createElement("canvas")
      out.width = src.width
      out.height = src.height
      const ctx = out.getContext("2d")
      if (!ctx) return src.toDataURL("image/png")
      ctx.fillStyle = background
      ctx.fillRect(0, 0, out.width, out.height)
      ctx.drawImage(src, 0, 0)
      return out.toDataURL("image/png")
    }
    return () => {
      captureRef.current = null
    }
  }, [captureRef, gl, advance])
  return null
}

/** Download what the stage shows as `fileName`, over the page's own colour
 * so a dark page exports dark - the rule the plate's and the elevation's
 * PNGs follow. */
export function downloadStagePng(
  capture: StageCapture | null,
  fileName: string
): void {
  try {
    const dark = document.documentElement.classList.contains("dark")
    const url = capture?.(dark ? "#09090b" : "#ffffff")
    if (!url) throw new Error("No canvas to read")
    const a = document.createElement("a")
    a.href = url
    a.download = fileName
    a.click()
  } catch {
    toast.error("Couldn't make the PNG")
  }
}

/** For one object standing at the origin: a floor that is not drawn and
 * only takes the key light's shadow, so the object stands on the page
 * instead of floating over it. Nothing to see where the tier casts no
 * shadows. */
export function ShadowFloor({ size }: { size: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow raycast={() => null}>
      <planeGeometry args={[size, size]} />
      <shadowMaterial transparent opacity={0.2} />
    </mesh>
  )
}

/** What a browser without WebGL gets instead of a 3D view. */
export function NoWebGL({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "flex h-full items-center justify-center p-8 text-sm text-muted-foreground",
        className
      )}
    >
      This browser can't do WebGL - the 3D view needs it. The 2D view has
      everything else.
    </div>
  )
}
