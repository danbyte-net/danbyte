// @vitest-environment jsdom
import { act } from "react"
import { afterEach, describe, expect, it } from "vitest"
import * as THREE from "three"
import {
  _roots,
  createRoot,
  events,
  extend,
  unmountComponentAtNode,
} from "@react-three/fiber"
import type { ThreeEvent } from "@react-three/fiber"

import { PORT_MARKERS_KEY, PortPickPrecedence } from "./port-pick"

extend(THREE as unknown as Parameters<typeof extend>[0])

// r3f's own event system, driven by hand: a module's bay box stands a hair
// in front of the port marker on its face, as in the viewer (and the room's
// device box in front of every port). The box and the marker carry the
// handler shapes BayHits and MarkerMesh use: both stop propagation, both
// track hover with pointer-out. Without the precedence filter, once the
// box had the pointer it kept stopping every move before the port saw it.

const canvases: HTMLCanvasElement[] = []

afterEach(async () => {
  for (const c of canvases.splice(0)) {
    await act(async () => unmountComponentAtNode(c))
  }
})

const fakeGl = (canvas: HTMLCanvasElement) =>
  ({
    setPixelRatio() {},
    setSize() {},
    render() {},
    dispose() {},
    domElement: canvas,
    shadowMap: { enabled: false, type: 0 },
    xr: {
      enabled: false,
      isPresenting: false,
      addEventListener() {},
      removeEventListener() {},
      setAnimationLoop() {},
    },
    outputColorSpace: "",
    toneMapping: 0,
    info: {},
    setAnimationLoop() {},
    getPixelRatio: () => 1,
  }) as unknown as THREE.WebGLRenderer

const QUAD = new THREE.PlaneGeometry(1, 1)
const BOX = new THREE.BoxGeometry(0.5, 0.5, 0.05)

function marker(): THREE.InstancedMesh {
  const im = new THREE.InstancedMesh(
    QUAD,
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
    1
  )
  // Facing the camera (−Z), 0.2 wide, on z = 0.
  const q = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 1, 0),
    Math.PI
  )
  im.setMatrixAt(
    0,
    new THREE.Matrix4().compose(
      new THREE.Vector3(0, 0, 0),
      q,
      new THREE.Vector3(0.2, 0.2, 1)
    )
  )
  im.computeBoundingSphere()
  return im
}

async function mount(precedence: boolean) {
  const canvas = document.createElement("canvas")
  canvases.push(canvas)
  const root = createRoot(canvas)
  await root.configure({
    gl: fakeGl(canvas),
    events,
    frameloop: "never",
    size: { width: 100, height: 100, top: 0, left: 0 },
    camera: { position: [0, 0, -1] },
  })
  const state = { bay: false, port: false, clicked: [] as string[] }
  const im = marker()
  await act(async () => {
    root.render(
      <>
        {precedence && <PortPickPrecedence />}
        {/* The bay box: its front face 0.5 mm proud of the port. */}
        <mesh
          geometry={BOX}
          position={[0, 0, 0.0245]}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation()
            state.bay = true
          }}
          onPointerOut={() => (state.bay = false)}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation()
            state.clicked.push("bay")
          }}
        >
          <meshBasicMaterial visible={false} />
        </mesh>
        <primitive
          object={im}
          userData={{ [PORT_MARKERS_KEY]: true }}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            e.stopPropagation()
            state.port = true
          }}
          onPointerOut={() => (state.port = false)}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation()
            state.clicked.push("port")
          }}
        />
      </>
    )
  })
  const store = _roots.get(canvas)!.store
  const s = store.getState()
  s.camera.lookAt(0, 0, 0)
  s.camera.updateMatrixWorld()
  // Never drawn (frameloop "never"): the world matrices by hand.
  s.scene.updateMatrixWorld(true)
  const h = s.events.handlers!
  const at = (x: number, y: number) =>
    ({
      offsetX: x,
      offsetY: y,
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
    }) as unknown as PointerEvent
  return {
    state,
    move: (x: number, y: number) => act(() => h.onPointerMove(at(x, y))),
    click: (x: number, y: number) =>
      act(() => {
        h.onPointerDown(at(x, y))
        h.onPointerUp(at(x, y))
        h.onClick(at(x, y))
      }),
  }
}

// The box spans about ±16 px of the 100 px canvas, the port ±6 px.
const BODY: [number, number] = [62, 50]
const PORT: [number, number] = [50, 50]

describe("a port on a module's face", () => {
  it("lost the pointer to the bay box without the precedence", async () => {
    const v = await mount(false)
    await v.move(...BODY)
    await v.move(...PORT)
    expect(v.state.port).toBe(false)
    expect(v.state.bay).toBe(true)
  })

  it("takes hover from the bay box, coming from the module's body", async () => {
    const v = await mount(true)
    await v.move(...BODY)
    expect(v.state).toMatchObject({ bay: true, port: false })
    await v.move(...PORT)
    expect(v.state).toMatchObject({ bay: false, port: true })
    // And hands it back on the body.
    await v.move(...BODY)
    expect(v.state).toMatchObject({ bay: true, port: false })
  })

  it("takes the click; the module's body still selects the module", async () => {
    const v = await mount(true)
    await v.move(...PORT)
    await v.click(...PORT)
    await v.move(...BODY)
    await v.click(...BODY)
    expect(v.state.clicked).toEqual(["port", "bay"])
  })
})
