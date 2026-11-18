import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react"
import { Html } from "@react-three/drei"
import type { ThreeEvent } from "@react-three/fiber"
import * as THREE from "three"

import { CordEndStore } from "@/lib/cord-run"
import type { Vec3 } from "@/lib/cord-run"
import {
  memberText,
  stackLinkText,
  stackProfile,
  stackRunPoints,
} from "@/lib/stacks"
import type {
  DeviceStack,
  SceneStack,
  StackLink,
  StackProfile,
} from "@/lib/stacks"
import type { StacksMode } from "@/lib/stacks-pref"

import { jacketsGeometry } from "./jacket-geometry"
import { KeepInView } from "./keep-in-view"
import { GHOST_OPACITY } from "./port-plugs"
import { PLUG_RENDER_ORDER } from "./plug-overlay"

/**
 * Switch stacks in a 3D view - the rack's page and the room
 * (docs/dcim/virtual-chassis.md → In 3D). One `StackScene` per view:
 *
 * - `ends`: where each drawn member's stack cables start, by device and
 *   interface - the head's `cable` empty, or the port's anchor when no
 *   head is drawn (port-plugs publishes them);
 * - `highlight`: the stack the pointer is over and the selected one, so
 *   every member lights together.
 */
export class StackHighlightStore {
  private hoveredId: string | null = null
  private selectedId: string | null = null
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  private bump() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  get hovered(): string | null {
    return this.hoveredId
  }

  get selected(): string | null {
    return this.selectedId
  }

  /** The pointer is over a member of `id` (null: off it). Leaving names
   * the stack it leaves, so a later hover elsewhere is not undone. */
  hover(id: string | null, leaving?: string | null) {
    if (id === null && leaving != null && this.hoveredId !== leaving) return
    if (this.hoveredId === id) return
    this.hoveredId = id
    this.bump()
  }

  /** A member of `id` is selected (null: none); a clear names the stack. */
  select(id: string | null, leaving?: string | null) {
    if (id === null && leaving != null && this.selectedId !== leaving) return
    if (this.selectedId === id) return
    this.selectedId = id
    this.bump()
  }

  /** How a member of `id` lights: as hovered, as selected, or not. */
  look(id: string | null | undefined): "hover" | "select" | null {
    if (!id) return null
    if (this.selectedId === id) return "select"
    if (this.hoveredId === id) return "hover"
    return null
  }
}

export interface StackScene {
  ends: CordEndStore
  highlight: StackHighlightStore
}

export function newStackScene(): StackScene {
  return { ends: new CordEndStore(), highlight: new StackHighlightStore() }
}

export const StackSceneContext = createContext<StackScene | null>(null)

/** The view's stacks; null outside a rack or room view. */
export function useStackScene(): StackScene | null {
  return useContext(StackSceneContext)
}

const noSubscribe = () => () => {}
const noVersion = () => 0

/** How a member of `stackId` lights now (re-rendering on a change). */
export function useStackLook(
  stackId: string | null | undefined
): "hover" | "select" | null {
  const h = useStackScene()?.highlight ?? null
  useSyncExternalStore(
    h?.subscribe ?? noSubscribe,
    h?.getVersion ?? noVersion,
    noVersion
  )
  return h?.look(stackId) ?? null
}

/** Tell the view a member of `stackId` is selected while `selected`. */
export function useStackSelect(
  stackId: string | null | undefined,
  selected: boolean
) {
  const h = useStackScene()?.highlight ?? null
  useEffect(() => {
    if (!h || !stackId || !selected) return
    h.select(stackId)
    return () => h.select(null, stackId)
  }, [h, stackId, selected])
}

/** A stack cable's colour when its cable names none: a dark jacket. */
export const STACK_CABLE_COLOR = "#27272a"

/**
 * Every stack cable of `stacks` between members drawn in this view, from
 * the ends their models published: recorded cables, or the ring derived
 * from member order. Ghost draws them see-through without writing depth,
 * before the port markers (PLUG_RENDER_ORDER); Hide draws none.
 */
export function StackCables({
  stacks,
  mode,
}: {
  stacks: readonly SceneStack[]
  mode: StacksMode
}) {
  const scene = useStackScene()
  const ends = scene?.ends ?? null
  const version = useSyncExternalStore(
    ends?.subscribe ?? noSubscribe,
    ends?.getVersion ?? noVersion,
    noVersion
  )
  const runs = useMemo(() => {
    if (!ends || mode === "hide") return []
    const out: {
      key: string
      link: StackLink
      names: [string, string]
      points: Vec3[]
      profile: StackProfile
    }[] = []
    for (const s of stacks) {
      const name = new Map(s.members.map((m) => [m.device, m.name]))
      for (const link of s.links) {
        const a = ends.get(link.a.device, link.a.name)
        const b = ends.get(link.b.device, link.b.name)
        if (!a || !b) continue
        out.push({
          key: `${link.a.device}:${link.a.name}>${link.b.device}:${link.b.name}`,
          link,
          names: [
            `${name.get(link.a.device) ?? ""} ${link.a.name}`.trim(),
            `${name.get(link.b.device) ?? ""} ${link.b.name}`.trim(),
          ],
          points: stackRunPoints(a, b, link),
          profile: stackProfile(a, b),
        })
      }
    }
    return out
    // `version` stands for what `ends` holds.
  }, [stacks, ends, mode, version])
  return (
    <>
      {runs.map((r) => (
        <StackTube
          key={r.key}
          points={r.points}
          profile={r.profile}
          link={r.link}
          names={r.names}
          ghost={mode === "ghost"}
        />
      ))}
    </>
  )
}

/** One stack cable: the head's profile - one round jacket, or a zip cord's
 * or ribbon's jackets side by side, untwisted from the heads' `cable`
 * empties (lib/cord-run frames). */
function StackTube({
  points,
  profile,
  link,
  names,
  ghost,
}: {
  points: Vec3[]
  profile: StackProfile
  link: StackLink
  names: [string, string]
  ghost: boolean
}) {
  const [hover, setHover] = useState<Vec3 | null>(null)
  const profileKey = JSON.stringify(profile)
  const geometry = useMemo(() => {
    const v = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
    const path = new THREE.CatmullRomCurve3(v, false, "centripetal")
    let length = 0
    for (let i = 0; i < v.length - 1; i++) length += v[i].distanceTo(v[i + 1])
    const segments = Math.min(400, Math.max(32, Math.round(length / 0.01)))
    if (profile.kind === "round")
      return new THREE.TubeGeometry(path, segments, profile.radius, 10, false)
    return jacketsGeometry(path, segments, profile, 8)
    // `profileKey` stands for `profile`.
  }, [points, profileKey])
  useEffect(() => () => geometry.dispose(), [geometry])
  return (
    <>
      <mesh
        geometry={geometry}
        renderOrder={ghost ? PLUG_RENDER_ORDER : 0}
        castShadow={!ghost}
        onPointerOver={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation()
          setHover([e.point.x, e.point.y, e.point.z])
        }}
        onPointerOut={() => setHover(null)}
      >
        <meshStandardMaterial
          color={link.color ?? STACK_CABLE_COLOR}
          roughness={0.6}
          metalness={0.05}
          transparent={ghost}
          opacity={ghost ? GHOST_OPACITY : 1}
          depthWrite={!ghost}
        />
      </mesh>
      {hover && (
        <Html
          position={hover}
          zIndexRange={[20, 0]}
          style={{ pointerEvents: "none" }}
        >
          <KeepInView>
            <div className="ml-3 -translate-y-1/2 rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
              <div className="font-semibold">{stackLinkText(link)}</div>
              <div className="font-mono text-muted-foreground">
                {names[0]} · {names[1]}
              </div>
              {link.label && (
                <div className="font-mono text-muted-foreground">
                  {link.label}
                </div>
              )}
            </div>
          </KeepInView>
        </Html>
      )}
    </>
  )
}

/** A stack member's hover card: the stack, its member number, the master. */
export function StackCard({ stack, at }: { stack: DeviceStack; at: Vec3 }) {
  return (
    <Html position={at} zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
      <KeepInView>
        <div className="-translate-y-full rounded-md border border-border bg-popover/95 px-2 py-1.5 text-[11px] whitespace-nowrap text-popover-foreground shadow-md">
          <div className="font-mono font-semibold">{stack.name}</div>
          <div className="text-muted-foreground">{memberText(stack)}</div>
          {!stack.master && stack.master_name && (
            <div className="text-muted-foreground">
              Master <span className="font-mono">{stack.master_name}</span>
            </div>
          )}
        </div>
      </KeepInView>
    </Html>
  )
}
