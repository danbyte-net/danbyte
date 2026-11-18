import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"
import type { ThreeEvent } from "@react-three/fiber"
import { useQueries } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Device } from "@/lib/api"
import type { DeviceLeds } from "@/lib/led-state"
import { plannedParts } from "@/lib/model-assembly"
import type { V3 } from "@/lib/model-ports"
import { effectivePluggables, usePluggablesMode } from "@/lib/pluggables-pref"
import { stackLayout } from "@/lib/stack-view"
import type { StackViewMember } from "@/lib/stack-view"
import { stackModeLeds } from "@/lib/stacks"
import type { DeviceStack } from "@/lib/stacks"
import { useStacksMode } from "@/lib/stacks-pref"
import { useDeviceLedsPayload } from "@/lib/use-device-leds"

import {
  PlacedModel,
  fittedModel,
  hasBakedAo,
  readyParts,
  sceneTriangleBudget,
  useDeviceModel,
  useDeviceModels,
} from "./device-model"
import { DEVICE_SELECTED, sharedBox, sharedEdges } from "./device-mesh"
import { FittedContent, ViewerFailed, ViewerLoading } from "./model-viewer"
import type { ModelViewerProps, Pickers } from "./model-viewer"
import { PlugOverlayScope } from "./plug-overlay"
import {
  StackCables,
  StackCard,
  StackSceneContext,
  newStackScene,
} from "./stack-scene"
import { ViewerStage } from "./viewer-stage"
import type { ViewPreset } from "./viewer-stage"
import { modelTargetM } from "./world"

/**
 * The device page's stack view (docs/dcim/virtual-chassis.md → On the
 * device page): the model viewer's Stack toggle on a stack member draws
 * every member the reader may view, stacked as lib/stack-view lays them
 * out, with the stack cables and their heads as the room draws them
 * (stack-scene; the Stacks choice shows, ghosts or hides them). The
 * current device is the viewer's own - its markers, bays, menus and
 * selection - outlined; the others are drawn plain, with a hover card
 * each and a click that selects them (the viewer's panel opens them).
 *
 * The members come from the device's own `/api/device-leds/` answer (its
 * stack's visible members), then one request for all of them (their
 * lights, plugs and the stack cables between them) and each member's
 * device record (its model and rack place). A stack of models past the
 * room's triangle budget draws the other members' far copies.
 */

/** Another member, as the viewer's panel shows it. */
export interface StackMemberPick {
  device: string
  name: string
  stack: DeviceStack
}

/** A member's line in the stack view, its model chosen. */
interface Drawn {
  device: string
  name: string
  current: boolean
  url: string
  far: boolean
  detail: Device
}

const NO_IDS: string[] = []

/** The userData flag of the current device's hit box. */
const CURRENT_HIT_KEY = "stackCurrent"

/** Whether the current device's body is nearer along the ray: a member
 * seen through it takes no hover or click. */
function behindCurrent(e: ThreeEvent<PointerEvent | MouseEvent>): boolean {
  return e.intersections.some(
    (h) => !!h.object.userData[CURRENT_HIT_KEY] && h.distance < e.distance
  )
}

export function StackModels({
  deviceId,
  props,
  pickers,
  fallback,
}: {
  deviceId: string
  props: ModelViewerProps
  pickers: Pickers
  /** The single-device view, when the stack has nothing more to draw. */
  fallback: ReactNode
}) {
  const stacksMode = useStacksMode()
  const own = useDeviceLedsPayload([deviceId])
  const stack =
    own.stacks.find((s) => s.members.some((m) => m.device === deviceId)) ?? null
  const idsKey = stack ? stack.members.map((m) => m.device).join(",") : ""
  const ids = useMemo(() => (idsKey ? idsKey.split(",") : NO_IDS), [idsKey])
  const payload = useDeviceLedsPayload(ids, ids.length > 1)
  const leds: Partial<Record<string, DeviceLeds>> = useMemo(
    () => stackModeLeds(payload.devices, stacksMode),
    [payload.devices, stacksMode]
  )
  const details = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["device", id],
      queryFn: () => api<Device>(`/api/devices/${id}/`),
      staleTime: 60_000,
    })),
  })
  const settled = details.every((q) => !q.isPending)
  const detailKey = details.map((q) => q.dataUpdatedAt).join(",")
  // The members with a model, and which copy each draws.
  const urls = useMemo(
    () =>
      details.flatMap((q) =>
        q.data?.model_3d_effective ? [q.data.model_3d_effective.url] : []
      ),
    // `detailKey` stands for `details`.
    [detailKey]
  )
  const fulls = useDeviceModels(urls)
  const drawn = useMemo((): Drawn[] => {
    if (!stack) return []
    let total = 0
    for (const u of urls) total += fulls.get(u)?.triangles ?? 0
    const over = total > sceneTriangleBudget()
    const out: Drawn[] = []
    for (const q of details) {
      const d = q.data
      const m = d?.model_3d_effective
      if (!d || !m) continue
      const current = d.id === deviceId
      const far = over && !current && !!m.far_url
      out.push({
        device: d.id,
        name: d.name,
        current,
        url: current ? props.model.url : far ? m.far_url! : m.url,
        far,
        detail: d,
      })
    }
    return out
    // `detailKey` stands for `details`.
  }, [stack, urls, fulls, detailKey, deviceId, props.model.url])
  const layout = useMemo(() => {
    const members: StackViewMember[] = drawn.map((x) => ({
      device: x.device,
      position:
        stack?.members.find((m) => m.device === x.device)?.position ?? 0,
      rack:
        x.detail.rack && x.detail.position != null
          ? { id: x.detail.rack.id, desc_units: x.detail.rack.desc_units }
          : null,
      u: x.detail.position,
      uHeight: x.detail.device_type?.u_height ?? x.detail.u_height,
    }))
    return stackLayout(members, deviceId)
  }, [drawn, stack, deviceId])

  // Each member's fitted size, as it lands: the stack's box and the
  // members' fronts lined up.
  const [sizes, setSizes] = useState<Partial<Record<string, V3>>>({})
  const onSize = useCallback((id: string, size: V3) => {
    setSizes((prev) => {
      const p = prev[id]
      if (p && p.every((v, i) => Math.abs(v - size[i]) < 1e-6)) return prev
      return { ...prev, [id]: size }
    })
  }, [])
  const [hovered, setHovered] = useState<string | null>(null)
  // A member's pointer leaving clears only its own hover.
  const onHover = useCallback((id: string, on: boolean) => {
    setHovered((prev) => (on ? id : prev === id ? null : prev))
  }, [])
  const [scene] = useState(newStackScene)
  const view: { preset: ViewPreset; n: number } = props.view ?? {
    preset: "front",
    n: 0,
  }
  const box = useMemo((): V3 => {
    let w = 0
    let h = 0
    let d = 0
    for (const x of drawn) {
      const s = sizes[x.device]
      if (!s) continue
      w = Math.max(w, s[0])
      h = Math.max(h, (layout.get(x.device) ?? 0) + s[1])
      d = Math.max(d, s[2])
    }
    return [w || 0.44, h || 0.045, d || 0.3]
  }, [drawn, sizes, layout])
  // A model with its own baked occlusion needs less of the screen's.
  const [baked, setBaked] = useState(false)

  // No stack in the device's own answer (or not yet), or no other member
  // to draw: the device alone.
  if (!stack || ids.length < 2) return <>{fallback}</>
  if (!settled) return <ViewerLoading />
  if (drawn.length < 2) return <>{fallback}</>
  const shadowKey = drawn.map((x) => x.url).join("|")
  return (
    <StackSceneContext.Provider value={scene}>
      <ViewerStage size={box} baked={baked} view={view} shadowKey={shadowKey}>
        {drawn.map((x) => {
          const s = sizes[x.device]
          const shift = s ? (s[2] - box[2]) / 2 : 0
          const memberLeds = leds[x.device] ?? null
          return (
            <group
              key={x.device}
              position={[0, layout.get(x.device) ?? 0, shift]}
            >
              <Member
                drawn={x}
                props={props}
                pickers={pickers}
                leds={memberLeds}
                hovered={hovered === x.device}
                selected={
                  pickers.selection?.kind === "member" &&
                  pickers.selection.member.device === x.device
                }
                onHover={onHover}
                onSize={onSize}
                onBaked={setBaked}
              />
            </group>
          )
        })}
        <StackCables stacks={payload.stacks} mode={stacksMode} />
      </ViewerStage>
    </StackSceneContext.Provider>
  )
}

/** One member in its place: the current device as the viewer draws it,
 * another plain; a hit box the model's size for its card and click. */
function Member({
  drawn: x,
  props,
  pickers,
  leds,
  hovered,
  selected,
  onHover,
  onSize,
  onBaked,
}: {
  drawn: Drawn
  props: ModelViewerProps
  pickers: Pickers
  leds: DeviceLeds | null
  hovered: boolean
  selected: boolean
  onHover: (id: string, on: boolean) => void
  onSize: (id: string, size: V3) => void
  onBaked: (baked: boolean) => void
}) {
  const model = x.current ? props.model : x.detail.model_3d_effective!
  const entry = useDeviceModel(x.url)
  // A far copy draws as it is; a full one with its modules in their bays.
  const planned = useMemo(
    () =>
      !x.far && entry?.status === "ready"
        ? plannedParts(model.bays, new Set(entry.anchors.bays))
        : [],
    [x.far, entry?.status, entry?.anchors, model.bays]
  )
  const partEntries = useDeviceModels(planned.map((p) => p.url))
  const parts = readyParts(planned, partEntries)
  const dt = x.current ? props.sizeMm : x.detail.device_type
  const w = dt?.width_mm ?? null
  const h = dt?.height_mm ?? null
  const dp = dt?.depth_mm ?? null
  const box = entry?.status === "ready" ? entry.box : null
  const fit = useMemo(
    () =>
      box
        ? fittedModel(
            box,
            { fit: model.fit, up: model.up, front: model.front },
            modelTargetM({ width_mm: w, height_mm: h, depth_mm: dp })
          )
        : null,
    [box, model.fit, model.up, model.front, w, h, dp]
  )
  useEffect(() => {
    if (fit) onSize(x.device, fit.size)
  }, [fit, x.device, onSize])
  useEffect(() => {
    if (x.current && entry?.scene) onBaked(hasBakedAo(entry.scene))
  }, [x.current, entry?.scene, onBaked])
  const pluggables = effectivePluggables(
    usePluggablesMode(),
    !!props.outlineAll
  )
  // A port of the current device under the pointer shows its own card.
  const [portHover, setPortHover] = useState(false)
  const onPortHover = useCallback(
    (port: string | null) => setPortHover(!!port),
    []
  )
  if (!entry || entry.status === "loading")
    return x.current ? <ViewerLoading /> : null
  if (!fit) return x.current ? <ViewerFailed /> : null
  const [mw, mh, md] = fit.size
  const stack = leds?.stack ?? null
  const outline = x.current || hovered || selected
  return (
    <PlugOverlayScope>
      {x.current ? (
        <FittedContent
          entry={entry}
          fit={fit}
          parts={parts}
          props={props}
          pickers={pickers}
          leds={leds}
          deviceId={x.device}
          onPortHover={onPortHover}
        />
      ) : (
        <PlacedModel
          entry={entry}
          fit={fit}
          parts={parts}
          bays={model.bays?.length ? model.bays : null}
          emptyMode={model.empty_mode}
          leds={leds}
          showPlugs={!x.far}
          pluggables={pluggables}
          deviceId={x.device}
        />
      )}
      {/* The pointer's target: one invisible box the model's size. The
          current device's lets its ports and bays take the pointer too,
          and a click on its body clears the selection like empty space;
          another member's takes neither through the current device. */}
      {x.current ? (
        <mesh
          position={[0, mh / 2, 0]}
          geometry={sharedBox(mw, mh, md)}
          userData={{ [CURRENT_HIT_KEY]: true }}
          onPointerOver={() => onHover(x.device, true)}
          onPointerOut={() => onHover(x.device, false)}
          onClick={() => pickers.onClearSelection?.()}
        >
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      ) : (
        <mesh
          position={[0, mh / 2, 0]}
          geometry={sharedBox(mw, mh, md)}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            if (behindCurrent(e)) {
              if (hovered) {
                document.body.style.cursor = ""
                onHover(x.device, false)
              }
              return
            }
            e.stopPropagation()
            if (!hovered) {
              document.body.style.cursor = "pointer"
              onHover(x.device, true)
            }
          }}
          onPointerOut={() => {
            if (hovered) document.body.style.cursor = ""
            onHover(x.device, false)
          }}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            if (behindCurrent(e)) return
            e.stopPropagation()
            if (stack)
              pickers.onSelectMember?.({
                device: x.device,
                name: x.name,
                stack,
              })
          }}
        >
          <meshBasicMaterial colorWrite={false} depthWrite={false} />
        </mesh>
      )}
      {outline && (
        <lineSegments
          position={[0, mh / 2, 0]}
          geometry={sharedEdges(mw, mh, md)}
          raycast={() => null}
        >
          <lineBasicMaterial
            color={x.current || selected ? DEVICE_SELECTED : "#71717a"}
            transparent={!(x.current || selected)}
            opacity={x.current || selected ? 1 : 0.6}
          />
        </lineSegments>
      )}
      {hovered && stack && !(x.current && portHover) && (
        <StackCard
          stack={stack}
          memberName={x.name}
          at={[-mw / 2, mh, -md / 2]}
        />
      )}
    </PlugOverlayScope>
  )
}
