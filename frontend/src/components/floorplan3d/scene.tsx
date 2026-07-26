import { useEffect, useMemo, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { Canvas, useThree } from "@react-three/fiber"
import { EffectComposer, N8AO } from "@react-three/postprocessing"
import * as THREE from "three"
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js"

import { detectRenderQuality } from "@/lib/render-quality"
import type { RenderQuality, RenderQualitySetting } from "@/lib/render-quality"
import { Link } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Cable,
  FacePorts,
  FloorPlanLiveState,
  InventoryItemRow,
  Paginated,
  TerminationInput,
} from "@/lib/api"
import { renderTemplateName } from "@/lib/faceplate-geometry"
import { bayHex, legendIsEmpty } from "@/lib/faceplate-colors"
import { useLegendCollector } from "@/components/speed-scale"
import { FaceplateLegend } from "@/components/device-faceplate"
import { InventoryItemDialog } from "@/components/device-inventory-pane"
import { InstallModuleDialog } from "@/components/device-modules-pane"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { CableForm } from "@/components/cable-form"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"

import { CablesLayer, CableTrace3D, useCablePaths } from "./cable-trace-3d"
import { CameraRig, type FlyToRequest } from "./camera-rig"
import { Room } from "./room"
import { RackMesh } from "./rack-mesh"
import type { Sel, ShellMode } from "./rack-mesh"
import { RaisedFloorMesh } from "./raised-floor-mesh"
import { TileGhostMesh } from "./tile-ghost-mesh"
import { TrayJunctionMesh, TrayMesh } from "./tray-mesh"
import { WallMesh } from "./wall-mesh"
import { useScene } from "./use-scene"
import {
  cellToWorld,
  rackFootprintM,
  rackViewpoint,
  trayElevationM,
  trayJunctions,
  webglSupported,
  type SceneDevice,
  type SceneTile,
  type SceneTray,
} from "./world"

/**
 * The 3D room view — the floor plan extruded into a navigable scene: racks as
 * cabinets at their tile positions (clickable devices at true U positions up
 * close), trays at their recorded elevations, monitoring beacons from the same
 * `/state/` poll the 2D canvas uses. Double-click a rack to fly the camera to
 * its front; `traceCableId` draws that cable's run as a marching line.
 *
 * This module (and everything under `floorplan3d/`) is the ONLY place three.js
 * may be imported; the route loads it via `React.lazy` so the 3D stack stays
 * in its own chunk. Default export for `lazy()`.
 */
export default function FloorScene3D({
  planId,
  liveState,
  traceCableId,
  showUNumbers = false,
  showNames = false,
  showAirflow = false,
  floorPeek = false,
  showCables = false,
  showWalls = true,
  showCeiling = false,
  shellMode = "cutaway",
  quality = "auto",
}: {
  planId: string
  liveState: FloorPlanLiveState | null
  traceCableId?: string | null
  /** Overlay toggles — owned by the route's View popover, like the 2D prefs. */
  showUNumbers?: boolean
  showNames?: boolean
  showAirflow?: boolean
  /** Lift the raised floor: translucent finished-floor slabs so underfloor
   * trays and cable runs read through the plenum. */
  floorPeek?: boolean
  showCables?: boolean
  /** Walls default ON — a drawn wall that silently didn't render would read
   * as a bug; hiding the room shell is the opt-in. */
  showWalls?: boolean
  /** Ceiling plane — default OFF; it only reads from inside the room. */
  showCeiling?: boolean
  /** Cabinet shell: solid (doors on) / cutaway (open frame) / x-ray. */
  shellMode?: ShellMode
  /** Effects budget (shadows, AO, dpr) — per-device, "auto" probes the GPU. */
  quality?: RenderQualitySetting
}) {
  const scene = useScene(planId)
  const qc = useQueryClient()
  const [selection, setSelection] = useState<Sel | null>(null)
  const [cableSel, setCableSel] = useState<string | null>(null)
  /** An opened tray: near rail dropped in 3D, contents listed in the HUD. */
  const [traySel, setTraySel] = useState<string | null>(null)
  const flyToRef = useRef<FlyToRequest | null>(null)
  // Focus (F): the selected rack/device stays lit, the rest of the room
  // ghosts. Session state, deliberately not persisted — it is a look, not a
  // preference.
  const [focusOn, setFocusOn] = useState(false)
  // Isolation: only these tile ids render (zone click or "Isolate row").
  const [isolation, setIsolation] = useState<{
    label: string
    ids: Set<string>
  } | null>(null)
  // Which face the camera last framed for the selected rack — the HUD's
  // front↔rear flip toggles it.
  const [viewSide, setViewSide] = useState<"front" | "rear">("front")
  // Per-area raised-floor lifts (click an area's edge skirt) — the global
  // "Lift raised floor" toggle and x-ray still lift everything.
  const [liftedIds, setLiftedIds] = useState<Set<string>>(new Set())
  // invalidate() bridge for HUD-triggered camera moves: DOM buttons live
  // outside the <Canvas>, and with frameloop="demand" a bare flyToRef
  // mutation would sit unnoticed until something else rendered a frame.
  const invalidateRef = useRef<(() => void) | null>(null)

  // ── Cable building ─────────────────────────────────────────────────────────
  // `connecting` holds the resolved A end while the user picks the far end in
  // 3D; `modal` opens the cable creator (pre-seeded with A, and B for the
  // pick-both flow). A port marker only carries a template name, so we resolve
  // it to a real termination via /devices/{id}/face-ports/ before cabling.
  const [connecting, setConnecting] = useState<{
    portLabel: string
    a: TerminationInput
    tileId: string
  } | null>(null)
  const [modal, setModal] = useState<{
    initialA: TerminationInput[]
    initialB?: TerminationInput[]
  } | null>(null)
  // Routing choice for the new cable: a same-rack patch stays point-to-point;
  // a cross-rack run can be assigned to ducts (trays) right here.
  const [routing, setRouting] = useState<"p2p" | "trays">("p2p")
  const [routeTrayIds, setRouteTrayIds] = useState<string[]>([])

  // ── Module install / part edit from a marker ──────────────────────────────
  // The same dialogs the 2D faceplate opens, hosted as plain DOM overlays
  // beside the cable modal (never inside the <Canvas>).
  const [installBay, setInstallBay] = useState<{
    deviceId: string
    id: string
    name: string
  } | null>(null)
  const [partEdit, setPartEdit] = useState<{
    deviceId: string
    id: string
    name: string
  } | null>(null)
  // Parts list for the editor — fetched only while it's open, on the Hardware
  // tab's cache key so an edit lands in both places.
  const partInventory = useQuery({
    queryKey: ["device-inventory", partEdit?.deviceId],
    queryFn: () =>
      api<Paginated<InventoryItemRow>>(
        `/api/inventory-items/?device=${partEdit!.deviceId}&page_size=500`
      ),
    enabled: !!partEdit,
  })
  const partItem = partEdit
    ? ((partInventory.data?.results ?? []).find((i) => i.id === partEdit.id) ??
      null)
    : null

  const resolvePort = async (sel: Sel) => {
    if (!sel.deviceId || !sel.portName) return null
    const fp = await qc.fetchQuery({
      queryKey: ["device-face-ports", sel.deviceId],
      queryFn: () => api<FacePorts>(`/api/devices/${sel.deviceId}/face-ports/`),
      staleTime: 30_000,
    })
    const list = sel.portSide ? fp[sel.portSide] : [...fp.front, ...fp.rear]
    return list.find((p) => p.marker === sel.portName) ?? null
  }

  // From the port HUD: "maker" opens the creator seeded with A only; "3d" arms
  // pick-the-far-end mode.
  const startConnect = async (sel: Sel, path: "maker" | "3d") => {
    const a = await resolvePort(sel)
    if (!a?.id || !a.kind) {
      toast.error("This port isn't defined on the device yet — can't cable it.")
      return
    }
    if (a.connected) {
      toast.error(`${a.name} is already cabled.`)
      return
    }
    const aInput: TerminationInput = { kind: a.kind, id: a.id }
    if (path === "maker") {
      setSelection(null)
      setRouting(scene.data?.trays.length ? "trays" : "p2p")
      setRouteTrayIds([])
      setModal({ initialA: [aInput] })
      return
    }
    setConnecting({ portLabel: a.name, a: aInput, tileId: sel.tileId })
  }

  // The far end was clicked while arming — resolve it and open the creator with
  // both ends seeded.
  const pickFarEnd = async (sel: Sel) => {
    if (!connecting) return
    const b = await resolvePort(sel)
    if (!b?.id || !b.kind) {
      toast.error("This port isn't defined on the device yet — can't cable it.")
      return
    }
    if (b.connected) {
      toast.error(`${b.name} is already cabled.`)
      return
    }
    if (b.id === connecting.a.id) {
      toast.error("Pick a different port for the other end.")
      return
    }
    // Same rack → a point-to-point patch; cross-rack defaults to ducts when
    // the plan has any to route through.
    const sameRack = connecting.tileId === sel.tileId
    setRouting(!sameRack && scene.data?.trays.length ? "trays" : "p2p")
    setRouteTrayIds([])
    setModal({
      initialA: [connecting.a],
      initialB: [{ kind: b.kind, id: b.id }],
    })
    setConnecting(null)
    setSelection(null)
  }

  // Assign the freshly created cable to the chosen ducts (tray M2M is set by
  // ids, so read-modify-write each tray).
  const assignTrays = async (cableId: string) => {
    for (const trayId of routeTrayIds) {
      try {
        const tray = await api<{ cables: { id: string }[] }>(
          `/api/floor-plan-trays/${trayId}/`
        )
        await api(`/api/floor-plan-trays/${trayId}/`, {
          method: "PATCH",
          body: JSON.stringify({
            cable_ids: [...new Set([...tray.cables.map((c) => c.id), cableId])],
          }),
        })
      } catch {
        toast.error(
          "Couldn't assign the cable to a duct — set it on the 2D plan."
        )
        return
      }
    }
  }

  // While arming, a port click is the far end; otherwise it selects normally.
  const handleSelect = (sel: Sel) => {
    if (connecting && sel.kind === "port") {
      void pickFarEnd(sel)
      return
    }
    setCableSel(null)
    // A different cabinet resets the flip — you arrive at its front. (Plain
    // sequential setState: the first version nested this inside the
    // setSelection updater, and a state update from inside an updater is a
    // render-phase side effect React is allowed to double-fire.)
    if (selection?.tileId !== sel.tileId) setViewSide("front")
    setSelection(sel)
  }

  // Esc cancels an in-flight connect.
  useEffect(() => {
    if (!connecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConnecting(null)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [connecting])

  // F toggles focus on the current selection; Escape unwinds focus first,
  // then isolation (the connect flow's own Esc wins while it is arming).
  useEffect(() => {
    const editable = (t: EventTarget | null) =>
      t instanceof Element &&
      t.closest('input, textarea, select, [contenteditable="true"]') !== null
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (editable(e.target)) return
      if (e.key === "f" || e.key === "F") {
        if (selection) setFocusOn((v) => !v)
        return
      }
      if (e.key === "Escape") {
        if (connecting) return
        if (focusOn) setFocusOn(false)
        else if (isolation) setIsolation(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selection, focusOn, isolation, connecting])

  // Every near-tier device reports the colours it draws; the HUD legend keys
  // their union (and hides when nothing photo-anchored is in view). Above the
  // WebGL/loading early returns — hook order has to be unconditional.
  const { content: legend, report: onLegend } = useLegendCollector()
  const supported = useMemo(webglSupported, [])
  // Where the operator is looking: the selected rack's centre. Racks between
  // the camera and this point auto-ghost (see RackMesh). Above the early
  // returns — hook order must be unconditional.
  const attention = useMemo<[number, number, number] | null>(() => {
    const d = scene.data
    if (!selection || !d) return null
    const t = d.tiles.find((x) => x.id === selection.tileId)
    if (!t?.rack) return null
    const [ax, az] = cellToWorld(d.plan, t.x + t.w / 2, t.y + t.h / 2)
    return [ax, rackFootprintM(t.rack).height / 2, az]
  }, [selection, scene.data])

  if (!supported)
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        This browser can't do WebGL — the 3D view needs it. The 2D view has
        everything else.
      </div>
    )
  if (scene.isError)
    return (
      <div className="p-4">
        <QueryError error={scene.error} />
      </div>
    )
  if (!scene.data)
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading scene…
      </div>
    )

  const data = scene.data
  const { plan } = data
  const [w, d] = cellToWorld(plan, plan.grid_width, plan.grid_height)
  const rackTiles = data.tiles.filter((t) => t.kind === "rack" && t.rack)
  const diag = Math.max(w, d)
  // Corners, tees and crossings across every tray — rails trim back to these
  // and a plate bridges each one.
  const trayJoints = trayJunctions(plan, data.trays)
  const trayJointPoints = trayJoints.map((j) => j.at)
  // Effects budget: Low = no shadows/AO and a capped dpr, Medium = shadows,
  // High = shadows + ambient occlusion. "auto" asks the GPU once.
  const rq: RenderQuality = quality === "auto" ? detectRenderQuality() : quality

  const selTile = selection
    ? (rackTiles.find((t) => t.id === selection.tileId) ?? null)
    : null
  const selDevice =
    (selection?.kind === "device" || selection?.kind === "port") && selTile
      ? (selTile.rack!.devices.find((x) => x.id === selection.deviceId) ?? null)
      : null

  // ── Isolation ──────────────────────────────────────────────────────────
  // Pure client state: a set of tile ids that stay mounted, everything else
  // unmounts (hidden racks can't be raycast, so nothing invisible eats
  // clicks). Zones and the room shell always stay — they are the context.
  // Entry points live on the rack HUD: a first version made zone patches
  // clickable, and every empty-floor click inside a zone isolated instead
  // of deselecting.
  const nonZoneTiles = data.tiles.filter((t) => !t.is_zone)
  const isolateZone = (zone: SceneTile) => {
    const ids = new Set(
      nonZoneTiles
        .filter(
          (t) =>
            t.x < zone.x + zone.w &&
            zone.x < t.x + t.w &&
            t.y < zone.y + zone.h &&
            zone.y < t.y + t.h
        )
        .map((t) => t.id)
    )
    if (ids.size === 0) {
      toast.info("Nothing stands in that zone yet.")
      return
    }
    setIsolation({
      label: zone.label || zone.type_name || "zone",
      ids,
    })
  }
  // Zones the selected rack stands in, most specific (smallest) first —
  // powers the HUD's "Isolate zone".
  const zonesForSelected = selTile
    ? data.tiles
        .filter(
          (z) =>
            z.is_zone &&
            selTile.x < z.x + z.w &&
            z.x < selTile.x + selTile.w &&
            selTile.y < z.y + z.h &&
            z.y < selTile.y + selTile.h
        )
        .sort((a, b) => a.w * a.h - b.w * b.h)
    : []
  const isolateRow = (anchor: SceneTile) => {
    // A row is whichever axis the hall actually runs: the alignment
    // (same-y vs same-x) that catches more racks wins.
    const sameY = rackTiles.filter((t) => t.y === anchor.y).length
    const sameX = rackTiles.filter((t) => t.x === anchor.x).length
    const ids = new Set(
      nonZoneTiles
        .filter((t) => (sameY >= sameX ? t.y === anchor.y : t.x === anchor.x))
        .map((t) => t.id)
    )
    setIsolation({
      label: `${anchor.label || anchor.rack?.name || "rack"} row`,
      ids,
    })
  }
  const shownRacks = isolation
    ? rackTiles.filter((t) => isolation.ids.has(t.id))
    : rackTiles

  // HUD front↔rear flip — same viewpoint math as the double-click fly-to.
  const flipView = () => {
    if (!selTile?.rack) return
    const side = viewSide === "front" ? "rear" : "front"
    const { height } = rackFootprintM(selTile.rack)
    const vp = rackViewpoint(plan, selTile, height, side)
    flyToRef.current = {
      target: new THREE.Vector3(vp.target[0], vp.target[1], vp.target[2]),
      position: new THREE.Vector3(
        vp.position[0],
        vp.position[1],
        vp.position[2]
      ),
    }
    setViewSide(side)
    // DOM button, demand frameloop: kick a frame so the rig sees the request.
    invalidateRef.current?.()
  }

  return (
    <div className="relative h-full min-h-0 w-full">
      <Canvas
        frameloop="demand"
        // `shadows` costs nothing until a light casts — the quality tier
        // gates that per light, so Low never pays the shadow pass.
        shadows
        // Render at the display's real pixel ratio (capped at 2): 1.75 left a
        // HiDPI canvas rendering below native and reading softer than the 2D
        // faceplate beside it. Low quality caps at 1.5 instead.
        dpr={rq === "low" || rq === "flat" ? [1, 1.5] : [1, 2]}
        camera={{
          position: [w / 2 + diag * 0.55, diag * 0.6, d + diag * 0.45],
          fov: 45,
          // Initial only — CameraRig re-fits `near` per frame to the orbit
          // distance (1 cm nose-on, 0.5 m across the hall).
          near: 0.05,
          far: diag * 10 + 50,
        }}
        onPointerMissed={() => {
          setSelection(null)
          setConnecting(null)
          setCableSel(null)
          // Focus follows the selection — a click into nothing ends both.
          setFocusOn(false)
        }}
      >
        <InvalidatorBridge apiRef={invalidateRef} />
        {/* Light rig: soft ambient + one shadow-casting key light + a dim
            fill, over a procedural studio environment (PMREM'd
            RoomEnvironment — zero assets, so airgap/CSP-safe). Intensities
            re-balanced for the environment's contribution; tone mapping is
            r3f's default ACESFilmic (that's why photo faceplates opt out
            with toneMapped={false}). */}
        {/* Flat: ONE full-strength ambient and nothing else — no key light,
            no shadow pass, no environment probe. Standard materials still
            shade, they just have a single uniform light to answer to, which
            is the cheapest honest way to take the light rig out of the
            picture. */}
        <ambientLight intensity={rq === "flat" ? 1.15 : 0.4} />
        {rq !== "flat" && (
          <>
            <KeyLight
              w={w}
              d={d}
              diag={diag}
              castShadow={rq !== "low"}
              shadowRes={rq === "high" ? 2048 : 1024}
            />
            <directionalLight position={[w, 8, d]} intensity={0.25} />
            <StudioEnvironment />
          </>
        )}
        {/* Ambient occlusion (High only): the interior depth that makes an
            open cabinet look deep rather than printed. Screen-space, so the
            depthWrite=false ghosts never smudge it. */}
        {rq === "high" && (
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
        <Room scene={data} xray={shellMode === "xray"} ceiling={showCeiling} />
        {shownRacks.map((t) => (
          <RackMesh
            key={t.id}
            plan={plan}
            tile={t}
            check={liveState?.tiles[t.id]?.check ?? null}
            selection={selection}
            attention={attention}
            showUNumbers={showUNumbers}
            showNames={showNames}
            showAirflow={showAirflow}
            shellMode={shellMode}
            ghosted={focusOn && !!selection && selection.tileId !== t.id}
            focusDeviceId={
              focusOn && selection?.tileId === t.id
                ? (selection.deviceId ?? null)
                : null
            }
            onSelect={handleSelect}
            onLegend={onLegend}
            onFlyTo={(target, position) => {
              flyToRef.current = { target, position }
              setViewSide("front")
            }}
          />
        ))}
        {data.trays.map((tr) => (
          <TrayMesh
            key={tr.id}
            plan={plan}
            tray={tr}
            areas={scene.data.raised_floors}
            junctions={trayJointPoints}
            selected={traySel === tr.id}
            onSelect={(id) => {
              setSelection(null)
              setCableSel(null)
              setTraySel((cur) => (cur === id ? null : id))
            }}
          />
        ))}
        {/* One plate per joint, at scene level: a crossing belongs to both
            runs, so drawing it per tray would stack two in one place. */}
        {trayJoints.map((j, i) => {
          const owner = data.trays.find((t) => t.id === j.trayIds[0])
          if (!owner) return null
          return (
            <TrayJunctionMesh
              key={`joint-${i}`}
              at={j.at}
              y={trayElevationM(plan, owner, scene.data.raised_floors)}
              color={owner.color || undefined}
            />
          )
        })}
        {(scene.data.raised_floors ?? []).map((a) => (
          <RaisedFloorMesh
            key={a.id}
            plan={plan}
            area={a}
            // X-ray lifts every raised floor — the plenum is half the point.
            peek={floorPeek || shellMode === "xray" || liftedIds.has(a.id)}
            onToggleLift={(id) =>
              setLiftedIds((prev) => {
                const next = new Set(prev)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
          />
        ))}
        {showWalls &&
          (scene.data.walls ?? []).map((wl) => (
            <WallMesh
              key={wl.id}
              plan={plan}
              wall={wl}
              mode={shellMode === "xray" ? "ghost" : "solid"}
            />
          ))}
        {/* Unlinked / non-rack tiles as ghost massing — a typed tile holds
            its ground before any object is linked ("build in advance"). */}
        {scene.data.tiles
          .filter(
            (t) =>
              !t.is_zone && !t.rack && (!isolation || isolation.ids.has(t.id))
          )
          .map((t) => (
            <TileGhostMesh key={`ghost-${t.id}`} plan={plan} tile={t} />
          ))}
        {showCables && (
          <CablesLayer
            planId={planId}
            scene={data}
            xray={shellMode === "xray"}
            selectedId={cableSel}
            onSelect={(id) => {
              setSelection(null)
              setTraySel(null)
              setCableSel(id)
            }}
          />
        )}
        {traceCableId && traceCableId !== cableSel && (
          <CableTrace3D planId={planId} scene={data} cableId={traceCableId} />
        )}
        <CameraRig
          target={[w / 2, 0.8, d / 2]}
          maxDistance={diag * 8 + 20}
          roomDiag={diag}
          requestRef={flyToRef}
        />
      </Canvas>
      {selTile && selection?.kind === "rack" && (
        <RackHud
          tile={selTile}
          liveState={liveState}
          focused={focusOn}
          viewSide={viewSide}
          onToggleFocus={() => setFocusOn((v) => !v)}
          onFlip={flipView}
          onIsolateRow={() => isolateRow(selTile)}
          onIsolateZone={
            zonesForSelected.length > 0
              ? () => isolateZone(zonesForSelected[0])
              : undefined
          }
        />
      )}
      {selTile && selDevice && selection?.kind === "device" && (
        <DeviceHud
          tile={selTile}
          dev={selDevice}
          focused={focusOn}
          onToggleFocus={() => setFocusOn((v) => !v)}
        />
      )}
      {/* Isolation pill — hidden racks must read as "isolated", never as
          "my racks vanished". */}
      {isolation && (
        <div
          className={`absolute ${connecting ? "bottom-16" : "bottom-4"} left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-popover/95 px-3 py-1.5 text-[12px] text-popover-foreground shadow-lg backdrop-blur`}
        >
          <span>
            Isolated: <span className="font-medium">{isolation.label}</span> ·{" "}
            <span className="num">{isolation.ids.size}</span> tile
            {isolation.ids.size === 1 ? "" : "s"}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setIsolation(null)}
          >
            Show all · Esc
          </Button>
        </div>
      )}
      {selTile && selDevice && selection?.kind === "port" && (
        <PortHud
          planId={planId}
          tile={selTile}
          dev={selDevice}
          selection={selection}
          onConnect={(path) => void startConnect(selection, path)}
          onInstall={(bay) => setInstallBay({ deviceId: selDevice.id, ...bay })}
          onEditPart={(part) =>
            setPartEdit({ deviceId: selDevice.id, ...part })
          }
        />
      )}
      {cableSel && <CableHud planId={planId} cableId={cableSel} />}
      {traySel && (
        <TrayHud
          planId={planId}
          tray={data.trays.find((t) => t.id === traySel) ?? null}
          onPickCable={(id) => {
            setTraySel(null)
            setCableSel(id)
          }}
          onClose={() => setTraySel(null)}
        />
      )}
      {/* Arming banner while the user picks the far end in 3D. */}
      {connecting && (
        <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-amber-500/40 bg-popover/95 px-3 py-2 text-[12px] text-popover-foreground shadow-lg backdrop-blur">
          <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-sm bg-amber-400" />
          <span>
            Click the other port to connect from{" "}
            <span className="font-mono font-semibold">
              {connecting.portLabel}
            </span>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2"
            onClick={() => setConnecting(null)}
          >
            Cancel
          </Button>
        </div>
      )}
      {/* Cable creator — seeded with the picked end(s); on save we just close
          and stay in the room view (occupancy + paths re-fetch). */}
      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect cable</DialogTitle>
          </DialogHeader>
          {modal && (
            <>
              {/* Routing — point-to-point (same-rack patch) or through the
                  plan's ducts, chosen up-front like an installer would. */}
              <div className="grid gap-1.5 rounded-md border border-border p-2.5">
                <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                  Routing
                </span>
                <RadioGroup
                  value={routing}
                  onValueChange={(v) => setRouting(v as typeof routing)}
                >
                  <div className="flex items-center gap-2 text-[13px]">
                    <RadioGroupItem value="p2p" id="cable-routing-p2p" />
                    <label htmlFor="cable-routing-p2p">
                      Point-to-point
                      <span className="text-muted-foreground">
                        {" "}
                        — patch inside the rack / straight run
                      </span>
                    </label>
                  </div>
                  <div className="flex items-center gap-2 text-[13px]">
                    <RadioGroupItem value="trays" id="cable-routing-trays" />
                    <label htmlFor="cable-routing-trays">
                      Through ducts
                      <span className="text-muted-foreground">
                        {" "}
                        — ride the plan's cable trays
                      </span>
                    </label>
                  </div>
                </RadioGroup>
                {routing === "trays" &&
                  (scene.data && scene.data.trays.length > 0 ? (
                    <div className="grid max-h-28 gap-0.5 overflow-y-auto rounded border border-border p-1">
                      {scene.data.trays.map((tr) => (
                        <label
                          key={tr.id}
                          className="flex items-center gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-muted/60"
                        >
                          <Checkbox
                            checked={routeTrayIds.includes(tr.id)}
                            onCheckedChange={(v) =>
                              setRouteTrayIds((cur) =>
                                v
                                  ? [...cur, tr.id]
                                  : cur.filter((x) => x !== tr.id)
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {tr.name}
                          </span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {tr.level}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      No ducts on this plan yet — draw trays in the 2D Cables
                      mode first.
                    </p>
                  ))}
              </div>
              <CableForm
                initialA={modal.initialA}
                initialB={modal.initialB}
                onSaved={(saved) => {
                  setModal(null)
                  // Port markers refresh via CableForm's own face-ports
                  // invalidation; the room's drawn runs are ours to re-ask.
                  const finish = () => {
                    qc.invalidateQueries({
                      queryKey: ["floor-plan-cable-paths", planId],
                    })
                  }
                  if (routing === "trays" && routeTrayIds.length) {
                    void assignTrays(saved.id).then(finish)
                  } else {
                    finish()
                  }
                }}
                onCancel={() => setModal(null)}
              />
            </>
          )}
        </DialogContent>
      </Dialog>
      {/* Module install / part editor for marker clicks — the same dialogs the
          2D faceplate opens (shared writes, toasts, and invalidations), so the
          clicked marker re-reads its occupancy/status on save. */}
      {installBay && (
        <InstallModuleDialog
          deviceId={installBay.deviceId}
          bay={installBay}
          onOpenChange={(o) => {
            if (!o) setInstallBay(null)
          }}
        />
      )}
      {partEdit && partInventory.isSuccess && (
        <InventoryItemDialog
          deviceId={partEdit.deviceId}
          item={partItem}
          initialName={partEdit.name}
          siblings={partInventory.data.results}
          open
          onOpenChange={(o) => {
            if (!o) setPartEdit(null)
          }}
        />
      )}
      {/* The SAME legend the 2D faceplate uses, keyed to what the near-tier
          devices actually draw — so it's absent until a photo panel with real
          ports is in view, and then explains only those colours. The overlay
          toggles live in the route's View popover. */}
      {!legendIsEmpty(legend) && (
        <div className="absolute top-3 right-3 rounded-lg border border-border bg-popover/90 p-2 text-popover-foreground shadow backdrop-blur">
          <FaceplateLegend observed content={legend} />
        </div>
      )}
    </div>
  )
}

/**
 * The shadow-casting key light, aimed at the room's centre with an
 * orthographic frustum fitted to the room — one shadow pass, paid only on
 * frames the demand loop already renders. Keyed by its shadow config so a
 * quality change rebuilds the map cleanly instead of resizing it in place.
 */
function KeyLight({
  w,
  d,
  diag,
  castShadow,
  shadowRes,
}: {
  w: number
  d: number
  diag: number
  castShadow: boolean
  shadowRes: number
}) {
  const target = useMemo(() => new THREE.Object3D(), [])
  const frustum = diag * 0.75 + 5
  return (
    <>
      <primitive object={target} position={[w / 2, 0, d / 2]} />
      <directionalLight
        key={`${castShadow}-${shadowRes}`}
        position={[w * 0.25, Math.max(10, diag * 0.6), d * 0.15]}
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
        shadow-camera-far={diag * 2 + 40}
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
 * per mount. Zero external assets (no HDRI fetch — CSP/airgap-safe), and it
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

/** invalidate() escape hatch for DOM overlays: with `frameloop="demand"`, a
 * HUD button that mutates a ref (fly-to) must kick a frame itself. */
function InvalidatorBridge({
  apiRef,
}: {
  apiRef: React.MutableRefObject<(() => void) | null>
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

/** Overlay card for the selected rack — name, live rollup, the operator's
 * focus/isolate/flip controls, jump-off. */
function RackHud({
  tile,
  liveState,
  focused,
  viewSide,
  onToggleFocus,
  onFlip,
  onIsolateRow,
  onIsolateZone,
}: {
  tile: SceneTile
  liveState: FloorPlanLiveState | null
  focused: boolean
  viewSide: "front" | "rear"
  onToggleFocus: () => void
  onFlip: () => void
  onIsolateRow: () => void
  /** Present only when the rack stands in a zone (smallest zone wins). */
  onIsolateZone?: () => void
}) {
  const rack = tile.rack!
  const live = liveState?.tiles[tile.id]
  return (
    <div className="absolute top-3 left-3 w-60 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[13px] font-semibold">
          {tile.label || rack.name}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {rack.u_height}U
        </span>
      </div>
      <div className="mt-1 grid gap-0.5 text-[12px] text-muted-foreground">
        <span>
          {rack.devices.length} device{rack.devices.length === 1 ? "" : "s"}
        </span>
        {live?.kind === "rack" && (
          <span>
            {live.used_units}/{live.u_height}U used
            {live.check ? ` · ${live.check}` : ""}
          </span>
        )}
        <span className="text-[11px]">double-click to zoom in</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant={focused ? "default" : "outline"}
          className="h-7"
          onClick={onToggleFocus}
          title="Ghost everything except this rack (F)"
        >
          Focus · F
        </Button>
        <Button size="sm" variant="outline" className="h-7" onClick={onFlip}>
          {viewSide === "front" ? "View rear" : "View front"}
        </Button>
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className={onIsolateZone ? "h-7" : "col-span-2 h-7"}
          onClick={onIsolateRow}
          title="Hide everything outside this rack's row (Esc restores)"
        >
          Isolate row
        </Button>
        {onIsolateZone && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={onIsolateZone}
            title="Hide everything outside this rack's zone (Esc restores)"
          >
            Isolate zone
          </Button>
        )}
      </div>
      <Button size="sm" variant="outline" asChild className="mt-1.5 h-7 w-full">
        <Link to="/racks/$id" params={{ id: rack.id }}>
          Open rack →
        </Link>
      </Button>
    </div>
  )
}

/** Overlay card for a selected device — identity, status, where it sits. */
function DeviceHud({
  tile,
  dev,
  focused,
  onToggleFocus,
}: {
  tile: SceneTile
  dev: SceneDevice
  focused: boolean
  onToggleFocus: () => void
}) {
  const rack = tile.rack!
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-right break-words">{value}</span>
    </div>
  )
  return (
    <div className="absolute top-3 left-3 w-64 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
          {dev.name}
        </span>
        {dev.status && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: `${dev.status.color || "#71717a"}26`,
              color: dev.status.color || undefined,
            }}
          >
            {dev.status.name}
          </span>
        )}
      </div>
      <div className="mt-1.5 grid gap-1 text-[12px]">
        {dev.device_type && row("Type", dev.device_type)}
        {dev.role_name &&
          row(
            "Role",
            <span className="inline-flex items-center gap-1.5">
              {dev.role_color && (
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: dev.role_color }}
                />
              )}
              {dev.role_name}
            </span>
          )}
        {row(
          "Position",
          dev.position != null
            ? `${rack.name} · U${dev.position}` +
                (dev.u_height > 1 ? `–${dev.position + dev.u_height - 1}` : "")
            : `${rack.name} · ${
                dev.mount === "side_left" ? "left" : "right"
              } side rail`
        )}
        {row(
          "Size",
          `${dev.u_height}U` +
            (dev.rack_width === "half" ? ` · half (${dev.rack_side})` : "") +
            (dev.face === "rear" ? " · rear" : "")
        )}
        {dev.primary_ip &&
          row(
            "Primary IP",
            <span className="font-mono">{dev.primary_ip}</span>
          )}
        {dev.serial_number &&
          row("Serial", <span className="font-mono">{dev.serial_number}</span>)}
      </div>
      <Button
        size="sm"
        variant={focused ? "default" : "outline"}
        className="mt-2 h-7 w-full"
        onClick={onToggleFocus}
        title="Ghost everything except this device (F)"
      >
        Focus · F
      </Button>
      <Button size="sm" variant="outline" asChild className="mt-1.5 h-7 w-full">
        <Link to="/devices/$id" params={{ id: dev.id }}>
          Open device →
        </Link>
      </Button>
    </div>
  )
}

/**
 * Overlay card for a clicked photo port. Resolves the marker to the real
 * component (same face-ports fetch the quads use), and:
 *  - free port → the connect flow (pick in 3D / cable maker)
 *  - cabled port → the cable (label/type/color) + the FAR END device:port,
 *    with jump-offs to the cable and an in-room trace of its run.
 */
function PortHud({
  planId,
  tile,
  dev,
  selection,
  onConnect,
  onInstall,
  onEditPart,
}: {
  planId: string
  tile: SceneTile
  dev: SceneDevice
  selection: Sel
  onConnect: (path: "maker" | "3d") => void
  /** An empty module bay was clicked — open the install dialog for it. */
  onInstall: (bay: { id: string; name: string }) => void
  /** A hardware marker (disk bay, PSU…) was clicked — open its part editor. */
  onEditPart: (part: { id: string; name: string }) => void
}) {
  const { canDo } = useMe()
  // Installing a module / editing a part writes to the device — the same gate
  // the Modules pane and the 2D faceplate use.
  const canEditParts = canDo("device", "change")
  const [choosing, setChoosing] = useState(false)
  const rack = tile.rack!
  // The saved marker name is a template ("Ethernet{position}/1"); render it the
  // same way the 2D faceplate does so the card shows the real port label.
  const portLabel = renderTemplateName(selection.portName ?? "", null)

  // Resolve this marker → real port (shared cache with the port quads).
  const facePorts = useQuery({
    queryKey: ["device-face-ports", dev.id],
    queryFn: () => api<FacePorts>(`/api/devices/${dev.id}/face-ports/`),
    staleTime: 30_000,
  })
  const fp = (
    selection.portSide
      ? (facePorts.data?.[selection.portSide] ?? [])
      : [...(facePorts.data?.front ?? []), ...(facePorts.data?.rear ?? [])]
  ).find((p) => p.marker === selection.portName)

  // Cabled → load the cable for its identity + far-end terminations.
  const cable = useQuery({
    queryKey: ["cable", fp?.cable_id],
    queryFn: () => api<Cable>(`/api/cables/${fp!.cable_id}/`),
    enabled: !!fp?.cable_id,
    staleTime: 30_000,
  })
  const farEnds = (() => {
    const c = cable.data
    if (!c || !fp?.id) return []
    const mine = (list: Cable["a_terminations"]) =>
      list.some((t) => t.id === fp.id)
    // The far side is whichever end does NOT carry this port.
    return mine(c.a_terminations) ? c.b_terminations : c.a_terminations
  })()

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3">
      <span className="shrink-0">{label}</span>
      <span className="min-w-0 flex-1 text-right break-words text-foreground">
        {value}
      </span>
    </div>
  )

  // Module bays resolve with `kind: null` too, so the MARKER's kind is what
  // separates them from hardware: a bay reads occupied/empty, not health.
  const bay = !!fp?.id && selection.portKind === "module-bay"
  // Hardware markers (inventory items) resolve with a status, never a
  // termination kind — the card shows part health, not cabling.
  const hardware = !!fp?.id && !bay && fp.kind === null
  // State chip, tinted like every other badge (bg = color at ~15%, text =
  // color). Hardware wears its status colour; bays their occupancy; ports
  // their cabling state.
  const chip = fp
    ? bay
      ? {
          label: fp.module ? "installed" : "empty",
          color: bayHex(!!fp.module),
        }
      : hardware
        ? {
            label: fp.status?.name || "part",
            color: fp.status?.color || "#64748b",
          }
        : fp.connected
          ? { label: "cabled", color: "#10b981" }
          : fp.id
            ? { label: "free", color: "#71717a" }
            : { label: "no port", color: "#71717a" }
    : null
  return (
    <div className="absolute top-3 left-3 w-72 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
          {fp?.name || portLabel}
        </span>
        {chip && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor: `${chip.color}26`,
              color: chip.color,
            }}
          >
            {chip.label}
          </span>
        )}
      </div>
      <div className="mt-1.5 grid gap-1 text-[12px] text-muted-foreground">
        {row("Device", <span className="font-mono">{dev.name}</span>)}
        {selection.portKind &&
          row(
            "Kind",
            <span className="capitalize">
              {selection.portKind.replace(/-/g, " ")}
            </span>
          )}
        {/* Side-mounted strips have no U — the rack alone locates them. */}
        {row(
          "Position",
          dev.position != null ? `${rack.name} · U${dev.position}` : rack.name
        )}
        {fp?.speed && row("Speed", <span className="num">{fp.speed}</span>)}
        {bay &&
          row(
            "Module",
            fp.module ? (
              <span className="font-mono">{fp.module.module_type.name}</span>
            ) : (
              "Empty"
            )
          )}
        {bay &&
          fp.module?.serial_number &&
          row(
            "Serial",
            <span className="font-mono">{fp.module.serial_number}</span>
          )}
      </div>

      {/* ── Drift: what SNMP saw, beside what the record says ──────────── */}
      {fp?.drift && (
        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">
            {fp.drift}
            <span className="mt-0.5 block text-muted-foreground">
              Review it on the device's Monitoring tab — nothing changes until
              you accept it.
            </span>
          </span>
        </div>
      )}

      {/* ── Cabled: the run + its far end ─────────────────────────────── */}
      {fp?.connected && (
        <div className="mt-2 grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-[12px] text-muted-foreground">
          {cable.isLoading && <span>Loading cable…</span>}
          {cable.data && (
            <>
              <div className="flex items-center gap-1.5">
                {cable.data.color && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: cable.data.color }}
                  />
                )}
                <span className="min-w-0 flex-1 font-mono break-words text-foreground">
                  {cable.data.label || `Cable #${cable.data.numid ?? ""}`}
                </span>
                {cable.data.type_display && (
                  <span className="shrink-0 text-[10px]">
                    {cable.data.type_display}
                  </span>
                )}
              </div>
              {farEnds.length > 0 ? (
                farEnds.map((t) => (
                  <div key={t.id} className="flex items-baseline gap-1.5">
                    <span className="shrink-0">→</span>
                    <Link
                      to="/devices/$id"
                      params={{ id: t.device.id }}
                      className="min-w-0 flex-1 font-mono break-words text-foreground hover:underline"
                    >
                      {t.device.name}
                      <span className="text-muted-foreground">:</span>
                      {t.name}
                    </Link>
                  </div>
                ))
              ) : (
                <span>Far end unterminated.</span>
              )}
              {cable.data.length && (
                <span className="num text-[11px]">
                  {cable.data.length} {cable.data.length_unit}
                </span>
              )}
            </>
          )}
          {cable.data && (
            <div className="mt-1 flex gap-1.5">
              <Button
                size="sm"
                variant="outline"
                asChild
                className="h-6 flex-1 px-2 text-[11px]"
              >
                <Link to="/cables/$id" params={{ id: cable.data.id }}>
                  Open cable
                </Link>
              </Button>
              <Button
                size="sm"
                variant="outline"
                asChild
                className="h-6 flex-1 px-2 text-[11px]"
              >
                {/* Same route, ?trace= — the room draws the run as a
                    marching line (and 2D uses the identical param). */}
                <Link
                  to="/floorplans/$id"
                  params={{ id: planId }}
                  search={{ viz: "3d" as const, trace: cable.data.id }}
                >
                  Trace run
                </Link>
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Free PORT: the connect flow (hardware parts can't cable) ───── */}
      {fp && !fp.connected && fp.id && fp.kind && (
        <>
          {choosing ? (
            <div className="mt-2 grid gap-1.5">
              <p className="text-[11px] text-muted-foreground">
                Connect this port…
              </p>
              <Button
                size="sm"
                className="h-7 w-full"
                onClick={() => {
                  setChoosing(false)
                  onConnect("3d")
                }}
              >
                Pick the other end in 3D
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full"
                onClick={() => {
                  setChoosing(false)
                  onConnect("maker")
                }}
              >
                Use the cable maker
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-full"
                onClick={() => setChoosing(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              className="mt-2 h-7 w-full"
              onClick={() => setChoosing(true)}
            >
              Connect cable
            </Button>
          )}
        </>
      )}
      {/* ── Empty BAY: seat a module right here (2D-faceplate parity) ──── */}
      {fp && bay && !fp.module && canEditParts && (
        <Button
          size="sm"
          className="mt-2 h-7 w-full"
          onClick={() => fp.id && onInstall({ id: fp.id, name: fp.name })}
        >
          Install module
        </Button>
      )}
      {/* ── Hardware part: the same editor the 2D faceplate opens ──────── */}
      {fp && hardware && canEditParts && (
        <Button
          size="sm"
          className="mt-2 h-7 w-full"
          onClick={() => fp.id && onEditPart({ id: fp.id, name: fp.name })}
        >
          Edit part
        </Button>
      )}
      {fp && !fp.id && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          No matching component on this device — add the interface (or fix the
          marker name) to cable it.
        </p>
      )}

      <Button size="sm" variant="outline" asChild className="mt-1.5 h-7 w-full">
        <Link to="/devices/$id" params={{ id: dev.id }}>
          Open device →
        </Link>
      </Button>
    </div>
  )
}

/**
 * Overlay card for a cable clicked in the cables layer — identity, both ends
 * (device:port, each a jump-off), length, and the run trace.
 */
/**
 * An opened tray: what actually rides through it. Clicking a tray in the room
 * is the natural "show me this duct's contents" gesture, and without this the
 * basket was scenery — you could see runs pass through but never ask which.
 */
function TrayHud({
  planId,
  tray,
  onPickCable,
  onClose,
}: {
  planId: string
  tray: SceneTray | null
  onPickCable: (cableId: string) => void
  onClose: () => void
}) {
  const paths = useCablePaths(planId)
  const carried = (paths.data?.cables ?? []).filter((c) =>
    tray ? c.tray_ids.includes(tray.id) : false
  )
  if (!tray) return null
  return (
    <div className="absolute top-3 left-3 w-72 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-center gap-2">
        {tray.color && (
          <span
            className="h-2.5 w-2.5 shrink-0 rounded-sm"
            style={{ backgroundColor: tray.color }}
          />
        )}
        <span className="min-w-0 flex-1 text-[13px] font-semibold break-words">
          {tray.name || "Cable tray"}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {carried.length} {carried.length === 1 ? "cable" : "cables"}
        </span>
      </div>
      <div className="mt-2 grid gap-0.5 text-[12px]">
        {carried.length === 0 ? (
          <span className="text-muted-foreground">
            Nothing routed through this tray yet — a cable follows it once its
            routing names it.
          </span>
        ) : (
          carried.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => onPickCable(c.id)}
              className="flex items-center gap-2 rounded px-1 py-0.5 text-left hover:bg-muted/60"
            >
              {c.color && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color }}
                />
              )}
              <span className="min-w-0 flex-1 font-mono break-words">
                {c.label || c.type || "Cable"}
              </span>
            </button>
          ))
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-7 w-full"
        onClick={onClose}
      >
        Close tray
      </Button>
    </div>
  )
}

function CableHud({ planId, cableId }: { planId: string; cableId: string }) {
  const cable = useQuery({
    queryKey: ["cable", cableId],
    queryFn: () => api<Cable>(`/api/cables/${cableId}/`),
    staleTime: 30_000,
  })
  const c = cable.data
  // What this run is set to FOLLOW. Without it the room showed a cable
  // ignoring an obvious tray with no way to tell whether that was the routing
  // or a bug — the answer is almost always "it's point-to-point".
  const scene = useScene(planId)
  const paths = useCablePaths(planId)
  const path = paths.data?.cables.find((p) => p.id === cableId)
  const followed = (path?.tray_ids ?? [])
    .map((id) => scene.data?.trays.find((t) => t.id === id))
    .filter((t): t is SceneTray => Boolean(t))
  const side = (label: string, terms: Cable["a_terminations"]) => (
    <div className="grid gap-0.5">
      <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {label}
      </span>
      {terms.length === 0 && (
        <span className="text-muted-foreground">unterminated</span>
      )}
      {terms.map((t) => (
        <Link
          key={t.id}
          to="/devices/$id"
          params={{ id: t.device.id }}
          className="min-w-0 font-mono break-words text-foreground hover:underline"
        >
          {t.device.name}
          <span className="text-muted-foreground">:</span>
          {t.name}
        </Link>
      ))}
    </div>
  )
  return (
    <div className="absolute top-3 left-3 w-72 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      {!c ? (
        <span className="text-[12px] text-muted-foreground">
          Loading cable…
        </span>
      ) : (
        <>
          <div className="flex items-center gap-2">
            {c.color && (
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: c.color }}
              />
            )}
            <span className="min-w-0 flex-1 font-mono text-[13px] font-semibold break-words">
              {c.label || `Cable #${c.numid ?? ""}`}
            </span>
            {c.type_display && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {c.type_display}
              </span>
            )}
          </div>
          <div className="mt-2 grid gap-2 text-[12px]">
            {side("A side", c.a_terminations)}
            {side("B side", c.b_terminations)}
            <div className="grid gap-0.5">
              <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Routing
              </span>
              {followed.length === 0 ? (
                <span className="text-muted-foreground">
                  Point-to-point — follows no tray
                </span>
              ) : (
                <span className="break-words">
                  {followed.map((t) => t.name || "tray").join(" → ")}
                </span>
              )}
            </div>
            {c.length && (
              <span className="num text-[11px] text-muted-foreground">
                {c.length} {c.length_unit}
              </span>
            )}
          </div>
          <div className="mt-2 flex gap-1.5">
            <Button size="sm" variant="outline" asChild className="h-7 flex-1">
              <Link to="/cables/$id" params={{ id: c.id }}>
                Open cable →
              </Link>
            </Button>
            <Button size="sm" variant="outline" asChild className="h-7 flex-1">
              <Link
                to="/floorplans/$id"
                params={{ id: planId }}
                search={{ viz: "3d" as const, trace: c.id }}
              >
                Trace run
              </Link>
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
