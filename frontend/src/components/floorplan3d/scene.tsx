import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import * as THREE from "three"

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
  ImagePortMarker,
  InventoryItemRow,
  Paginated,
  Rack,
  TerminationInput,
} from "@/lib/api"
import { legendIsEmpty } from "@/lib/faceplate-colors"
import { useLegendCollector } from "@/components/speed-scale"
import { FaceplateLegend } from "@/components/device-faceplate"
import { LegendFrame } from "@/components/map-legend"
import { InventoryItemDialog } from "@/components/device-inventory-pane"
import { InstallModuleDialog } from "@/components/device-modules-pane"
import { Button } from "@/components/ui/button"
import { Loading } from "@/components/loading"
import { BarButton } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
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
import { usePortLabelsShown } from "@/lib/port-labels-pref"

import {
  cableEndsAnchored,
  CablesLayer,
  CableTrace3D,
  useCablePaths,
} from "./cable-trace-3d"
import {
  CabinetDeviceHoverHud,
  CabinetDeviceHud,
  CabinetHoverHud,
  CabinetHud,
  CabinetPortHoverHud,
  CabinetPortHud,
  createHoverStore,
  deviceHoverKey,
  portHoverKey,
} from "./cabinet-hud"
import { CabinetMesh } from "./cabinet-mesh"
import { DeviceHud, PortHud, rackPortPosition } from "./hud-cards"
import { PartMarkerMenu, useCanSetPartStatus } from "@/components/part-status"
import type { PartMarkerAt } from "@/components/part-status"
import type { FlyToRequest } from "./camera-rig"
import { Room } from "./room"
import { RackMesh } from "./rack-mesh"
import type { Sel, ShellMode } from "./rack-mesh"
import { RackHud } from "./rack-hud"
import { roomStamp } from "./room-stamp"
import { RaisedFloorMesh } from "./raised-floor-mesh"
import { NoWebGL, Stage, roomLights } from "./stage"
import { TileGhostMesh } from "./tile-ghost-mesh"
import { TrayJunctionMesh, TrayMesh } from "./tray-mesh"
import { WallMesh } from "./wall-mesh"
import { useScene } from "./use-scene"
import {
  cabinetBoxM,
  cellToWorld,
  rackFootprintM,
  rackViewpoint,
  trayElevationM,
  trayJunctions,
  webglSupported,
  type SceneTile,
  type SceneTray,
} from "./world"

/**
 * The 3D room view - the floor plan extruded into a navigable scene: racks as
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
  hiddenTileIds,
  traceCableId,
  showUNumbers = false,
  showNames = false,
  namesScope = "all",
  namesAtEdge = false,
  showAirflow = false,
  floorPeek = false,
  showCables = false,
  showWalls = true,
  showCeiling = false,
  shellMode = "cutaway",
  quality = "auto",
  cableScale = 1,
  cableLook = "auto",
  tints,
  racks,
  pointTileIds,
  focusRack = null,
}: {
  planId: string
  liveState: FloorPlanLiveState | null
  /** Tiles the plan's eyes have switched off - not drawn here either. */
  hiddenTileIds?: Set<string>
  traceCableId?: string | null
  /** Overlay toggles - owned by the route's View popover, like the 2D prefs. */
  showUNumbers?: boolean
  showNames?: boolean
  /** Name plates on every rack, or only the highlighted one. */
  namesScope?: "all" | "selected"
  /** Name plates start at the rail edge and run off the gear. */
  namesAtEdge?: boolean
  showAirflow?: boolean
  /** Lift the raised floor: translucent finished-floor slabs so underfloor
   * trays and cable runs read through the plenum. */
  floorPeek?: boolean
  showCables?: boolean
  /** Walls default ON - a drawn wall that silently didn't render would read
   * as a bug; hiding the room shell is the opt-in. */
  showWalls?: boolean
  /** Ceiling plane - default OFF; it only reads from inside the room. */
  showCeiling?: boolean
  /** Cabinet shell: solid (doors on) / cutaway (open frame) / x-ray. */
  shellMode?: ShellMode
  /** Effects budget (shadows, AO, dpr) - per-device, "auto" probes the GPU. */
  quality?: RenderQualitySetting
  /** Cable jacket multiplier - 1 is life size; per-device, from the View menu. */
  cableScale?: number
  /** Tubes, lines, or auto (tubes up to the room's tube limit). */
  cableLook?: "auto" | "tubes" | "lines"
  /** Each rack tile's colour under the plan's Color by (#247), by tile id -
   * the 2D fill, as the cabinet's tint. */
  tints?: ReadonlyMap<string, string>
  /** The plan's racks with their figures, by rack id, when the plan has
   * asked for them - the selected rack's card reads them. */
  racks?: ReadonlyMap<string, Rack>
  /** Rack tiles pointed at from the rack table: lit as selected. */
  pointTileIds?: ReadonlySet<string>
  /** A rack table row clicked: select that rack and fly to its front. A
   * new `n` flies again to the same rack. */
  focusRack?: { tileId: string; n: number } | null
}) {
  const scene = useScene(planId)
  const qc = useQueryClient()
  // Read once here; every rack and device gets the values as props. The
  // viewer's own switch (View menu) can clear the labels off this screen.
  const { faceplatePortLabels, faceplatePortLabelColor } = useMe()
  const portLabelsShown = usePortLabelsShown()
  const [selection, setSelection] = useState<Sel | null>(null)
  // A right-click on a disk or a PSU: its part's statuses at the pointer.
  const canSetStatus = useCanSetPartStatus()
  const [partMenu, setPartMenu] = useState<PartMarkerAt | null>(null)
  const [cableSel, setCableSel] = useState<string | null>(null)
  /** An opened tray: near rail dropped in 3D, contents listed in the HUD. */
  const [traySel, setTraySel] = useState<string | null>(null)
  const flyToRef = useRef<FlyToRequest | null>(null)
  // Focus (F): the selected rack/device stays lit, the rest of the room
  // ghosts. Session state, deliberately not persisted - it is a look, not a
  // preference.
  const [focusOn, setFocusOn] = useState(false)
  // Isolation: only these tile ids render (zone click or "Isolate row").
  const [isolation, setIsolation] = useState<{
    label: string
    ids: Set<string>
  } | null>(null)
  // Which face the camera last framed for the selected rack - the HUD's
  // front↔rear flip toggles it.
  const [viewSide, setViewSide] = useState<"front" | "rear">("front")
  // Per-area raised-floor lifts (click an area's edge skirt) - the global
  // "Lift raised floor" toggle and x-ray still lift everything.
  const [liftedIds, setLiftedIds] = useState<Set<string>>(new Set())
  // The cabinet under the pointer, for its card - kept out of this
  // component's state so a hover never re-renders the room.
  const [hoverStore] = useState(createHoverStore)
  // The same for a device inside an open cabinet, keyed tile/device.
  const [deviceHover] = useState(createHoverStore)
  const hoverCabinetDevice = useCallback(
    (tileId: string, deviceId: string, on: boolean) =>
      deviceHover.set(deviceHoverKey(tileId, deviceId), on),
    [deviceHover]
  )
  // And for a port on one of those devices' photos.
  const [portHover] = useState(createHoverStore)
  const hoverCabinetPort = useCallback(
    (tileId: string, deviceId: string, marker: ImagePortMarker, on: boolean) =>
      portHover.set(
        portHoverKey({
          tileId,
          deviceId,
          marker: marker.name,
          kind: marker.kind,
        }),
        on
      ),
    [portHover]
  )
  // Cabinet doors standing open, by tile. Opening one is what fetches its
  // insides, so a room never loads the contents of a shut cabinet.
  const [openDoors, setOpenDoors] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  const toggleDoor = (tileId: string) =>
    setOpenDoors((prev) => {
      const next = new Set(prev)
      if (next.has(tileId)) next.delete(tileId)
      else next.add(tileId)
      return next
    })
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
  // Parts list for the editor - fetched only while it's open, on the Hardware
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
      toast.error("This port isn't defined on the device yet - can't cable it.")
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

  // The far end was clicked while arming - resolve it and open the creator with
  // both ends seeded.
  const pickFarEnd = async (sel: Sel) => {
    if (!connecting) return
    const b = await resolvePort(sel)
    if (!b?.id || !b.kind) {
      toast.error("This port isn't defined on the device yet - can't cable it.")
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
          "Couldn't assign the cable to a duct - set it on the 2D plan."
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
    // A different cabinet resets the flip - you arrive at its front. (Plain
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

  // A rack table row clicked under the room: select that rack and fly to
  // its front - the double-click's framing - once the room has loaded.
  const focusedRef = useRef(0)
  useEffect(() => {
    const d = scene.data
    if (!focusRack || !d || focusedRef.current === focusRack.n) return
    const t = d.tiles.find((x) => x.id === focusRack.tileId)
    if (!t?.rack) return
    focusedRef.current = focusRack.n
    setCableSel(null)
    setTraySel(null)
    setSelection({ kind: "rack", tileId: t.id })
    setViewSide("front")
    const vp = rackViewpoint(d.plan, t, rackFootprintM(t.rack).height, "front")
    flyToRef.current = {
      target: new THREE.Vector3(...vp.target),
      position: new THREE.Vector3(...vp.position),
    }
    // A prop change, demand frameloop: kick a frame so the rig moves.
    invalidateRef.current?.()
  }, [focusRack, scene.data])

  // Every near-tier device reports the colours it draws; the HUD legend keys
  // their union (and hides when nothing photo-anchored is in view). Above the
  // WebGL/loading early returns - hook order has to be unconditional.
  const { content: legend, report: onLegend } = useLegendCollector()
  const supported = useMemo(webglSupported, [])
  // Where the operator is looking: the selected rack's centre. Racks between
  // the camera and this point auto-ghost (see RackMesh). Above the early
  // returns - hook order must be unconditional.
  const attention = useMemo<[number, number, number] | null>(() => {
    const d = scene.data
    if (!selection || !d) return null
    const t = d.tiles.find((x) => x.id === selection.tileId)
    const height = t?.rack
      ? rackFootprintM(t.rack).height
      : t?.cabinet
        ? cabinetBoxM(t.cabinet).height
        : null
    if (!t || height == null) return null
    const [ax, az] = cellToWorld(d.plan, t.x + t.w / 2, t.y + t.h / 2)
    return [ax, height / 2, az]
  }, [selection, scene.data])

  if (!supported) return <NoWebGL />
  if (scene.isError)
    return (
      <div className="p-4">
        <QueryError error={scene.error} />
      </div>
    )
  if (!scene.data) return <Loading />

  const data = scene.data
  const { plan } = data
  const [w, d] = cellToWorld(plan, plan.grid_width, plan.grid_height)
  const rackTiles = data.tiles.filter(
    (t) => t.kind === "rack" && t.rack && !hiddenTileIds?.has(t.id)
  )
  // DIN-rail cabinets: closed boxes at their outer size.
  const cabinetTiles = data.tiles.filter(
    (t) => t.cabinet && !hiddenTileIds?.has(t.id)
  )
  const diag = Math.max(w, d)
  // Corners, tees and crossings across every tray - rails trim back to these
  // and a plate bridges each one.
  const trayJoints = trayJunctions(plan, data.trays)
  const trayJointPoints = trayJoints.map((j) => j.at)
  // Effects budget: Low = no shadows/AO and a capped dpr, Medium = shadows,
  // High = shadows + ambient occlusion. "auto" asks the GPU once.
  const detected: RenderQuality =
    quality === "auto" ? detectRenderQuality() : quality
  // Big-hall guard: the shadow pass re-renders the whole scene from the light
  // every frame, so a hundred cabinets of gear shadow-cast is the dominant
  // per-frame cost. Above this many racks, Auto/High fall back to "low" (no
  // shadows, no AO) - the room stays readable and the frame rate holds. An
  // explicit Flat pick is already the cheapest and is left alone; an explicit
  // Low/Medium is the operator's call and is respected.
  const BIG_HALL_RACKS = 40
  const rq: RenderQuality =
    quality === "auto" && rackTiles.length > BIG_HALL_RACKS ? "low" : detected

  const selTile = selection
    ? (rackTiles.find((t) => t.id === selection.tileId) ?? null)
    : null
  const selDevice =
    (selection?.kind === "device" || selection?.kind === "port") && selTile
      ? (selTile.rack!.devices.find((x) => x.id === selection.deviceId) ?? null)
      : null
  const selCabinet =
    selection?.kind === "cabinet"
      ? (cabinetTiles.find((t) => t.id === selection.tileId) ?? null)
      : null
  // The cabinet behind a tile, for the cards of the devices inside it.
  const cabinetOf = (tileId: string) => {
    const t = cabinetTiles.find((x) => x.id === tileId)
    return t?.cabinet
      ? { id: t.cabinet.id, name: t.label || t.cabinet.name }
      : null
  }
  // A device clicked inside an open cabinet: that cabinet. A port on one of
  // its devices' photos the same.
  const selCabinetDevice =
    selection?.kind === "device" ? cabinetOf(selection.tileId) : null
  const selCabinetPort =
    selection?.kind === "port" ? cabinetOf(selection.tileId) : null

  // ── Isolation ──────────────────────────────────────────────────────────
  // Pure client state: a set of tile ids that stay mounted, everything else
  // unmounts (hidden racks can't be raycast, so nothing invisible eats
  // clicks). Zones and the room shell always stay - they are the context.
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
  // Zones a tile stands in, most specific (smallest) first - powers the
  // HUD's "Isolate zone".
  const zonesAround = (tile: SceneTile | null) =>
    tile
      ? data.tiles
          .filter(
            (z) =>
              z.is_zone &&
              tile.x < z.x + z.w &&
              z.x < tile.x + tile.w &&
              tile.y < z.y + z.h &&
              z.y < tile.y + tile.h
          )
          .sort((a, b) => a.w * a.h - b.w * b.h)
      : []
  const zonesForSelected = zonesAround(selTile)
  const zonesForCabinet = zonesAround(selCabinet)
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
      label: `${anchor.label || anchor.rack?.name || anchor.cabinet?.name || "rack"} row`,
      ids,
    })
  }
  const shownRacks = isolation
    ? rackTiles.filter((t) => isolation.ids.has(t.id))
    : rackTiles
  const shownCabinets = isolation
    ? cabinetTiles.filter((t) => isolation.ids.has(t.id))
    : cabinetTiles

  // HUD front↔rear flip - same viewpoint math as the double-click fly-to.
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
      <Stage
        quality={rq}
        camera={{
          position: [w / 2 + diag * 0.55, diag * 0.6, d + diag * 0.45],
          far: diag * 10 + 50,
        }}
        lights={roomLights(w, d, diag)}
        controls={{
          target: [w / 2, 0.8, d / 2],
          maxDistance: diag * 8 + 20,
          roomDiag: diag,
          requestRef: flyToRef,
        }}
        // Every view setting, the racks' tints among them: a change the
        // demand frameloop doesn't see would leave the old picture.
        stamp={roomStamp({
          showWalls,
          showCables,
          showCeiling,
          showAirflow,
          showNames,
          namesScope,
          namesAtEdge,
          showUNumbers,
          floorPeek,
          shellMode,
          quality: rq,
          tints,
          pointed: pointTileIds,
        })}
        invalidateRef={invalidateRef}
        onPointerMissed={() => {
          setSelection(null)
          setConnecting(null)
          setCableSel(null)
          // Focus follows the selection - a click into nothing ends both.
          setFocusOn(false)
        }}
      >
        <Room scene={data} xray={shellMode === "xray"} ceiling={showCeiling} />
        {shownRacks.map((t) => (
          <RackMesh
            key={t.id}
            plan={plan}
            tile={t}
            check={liveState?.tiles[t.id]?.check ?? null}
            tint={tints?.get(t.id) ?? null}
            highlighted={!!pointTileIds?.has(t.id)}
            selection={selection}
            attention={attention}
            showUNumbers={showUNumbers}
            showNames={showNames}
            namesScope={namesScope}
            namesAtEdge={namesAtEdge}
            portLabelSource={portLabelsShown ? faceplatePortLabels : ""}
            portLabelColor={faceplatePortLabelColor}
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
            onPortMenu={
              canSetStatus
                ? (sel, at) =>
                    sel.deviceId &&
                    sel.portName &&
                    setPartMenu({
                      ...at,
                      deviceId: sel.deviceId,
                      marker: sel.portName,
                      side: sel.portSide,
                    })
                : undefined
            }
            onFlyTo={(target, position) => {
              flyToRef.current = { target, position }
              setViewSide("front")
            }}
          />
        ))}
        {shownCabinets.map((t) => (
          <CabinetMesh
            key={t.id}
            plan={plan}
            tile={t}
            check={liveState?.tiles[t.id]?.check ?? null}
            selected={
              selection?.tileId === t.id && selection.kind === "cabinet"
            }
            ghosted={focusOn && !!selection && selection.tileId !== t.id}
            xray={shellMode === "xray"}
            attention={attention}
            doorOpen={openDoors.has(t.id)}
            selectedDeviceId={
              selection?.tileId === t.id &&
              (selection.kind === "device" || selection.kind === "port")
                ? (selection.deviceId ?? null)
                : null
            }
            selectedPort={
              selection?.tileId === t.id &&
              selection.kind === "port" &&
              selection.deviceId &&
              selection.portName
                ? { deviceId: selection.deviceId, marker: selection.portName }
                : null
            }
            // A hold on a port inside draws amber, as on the rack page.
            markReserved
            portLabelSource={portLabelsShown ? faceplatePortLabels : ""}
            portLabelColor={faceplatePortLabelColor}
            onSelect={handleSelect}
            onHover={hoverStore.set}
            onSelectDevice={(tileId, deviceId) =>
              handleSelect({ kind: "device", tileId, deviceId })
            }
            onHoverDevice={hoverCabinetDevice}
            onSelectPort={(tileId, deviceId, marker) =>
              handleSelect({
                kind: "port",
                tileId,
                deviceId,
                portName: marker.name,
                portKind: marker.kind,
                portSide: "front",
              })
            }
            onHoverPort={hoverCabinetPort}
            onPortMenu={
              canSetStatus
                ? (_, deviceId, marker, at) =>
                    setPartMenu({
                      ...at,
                      deviceId,
                      marker: marker.name,
                      side: "front",
                    })
                : undefined
            }
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
            // X-ray lifts every raised floor - the plenum is half the point.
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
        {/* Unlinked / non-rack tiles as ghost massing - a typed tile holds
            its ground before any object is linked ("build in advance"). */}
        {scene.data.tiles
          .filter(
            (t) =>
              !t.is_zone &&
              !t.rack &&
              !t.cabinet &&
              !hiddenTileIds?.has(t.id) &&
              (!isolation || isolation.ids.has(t.id))
          )
          .map((t) => (
            <TileGhostMesh key={`ghost-${t.id}`} plan={plan} tile={t} />
          ))}
        {showCables && (
          <CablesLayer
            planId={planId}
            scene={data}
            xray={shellMode === "xray"}
            scale={cableScale}
            look={cableLook}
            selectedId={cableSel}
            onSelect={(id) => {
              setSelection(null)
              setTraySel(null)
              setCableSel(id)
            }}
          />
        )}
        {traceCableId && traceCableId !== cableSel && (
          <CableTrace3D
            planId={planId}
            scene={data}
            cableId={traceCableId}
            scale={cableScale}
          />
        )}
      </Stage>
      {selTile && selection?.kind === "rack" && (
        <RackHud
          tile={selTile}
          liveState={liveState}
          info={racks?.get(selTile.rack!.id)}
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
      {selCabinet && (
        <CabinetHud
          tile={selCabinet}
          liveState={liveState}
          actions={{
            focused: focusOn,
            onToggleFocus: () => setFocusOn((v) => !v),
            doorOpen: openDoors.has(selCabinet.id),
            onToggleDoor: () => toggleDoor(selCabinet.id),
            onIsolateRow: () => isolateRow(selCabinet),
            onIsolateZone:
              zonesForCabinet.length > 0
                ? () => isolateZone(zonesForCabinet[0])
                : undefined,
          }}
        />
      )}
      <CabinetHoverHud
        store={hoverStore}
        tiles={shownCabinets}
        liveState={liveState}
        hidden={!!selection || !!cableSel || !!traySel}
      />
      <CabinetDeviceHoverHud
        store={deviceHover}
        cabinetOf={cabinetOf}
        hidden={!!selection || !!cableSel || !!traySel}
      />
      <CabinetPortHoverHud
        store={portHover}
        cabinetOf={cabinetOf}
        hidden={!!selection || !!cableSel || !!traySel}
        showReserved
      />
      {selCabinetPort &&
        selection?.kind === "port" &&
        selection.deviceId &&
        selection.portName && (
          // The room's port card, its flows and all: a port in a cabinet
          // cables, installs and traces as a racked one does.
          <CabinetPortHud
            cabinet={selCabinetPort}
            port={{
              tileId: selection.tileId,
              deviceId: selection.deviceId,
              marker: selection.portName,
              kind: selection.portKind ?? "",
            }}
            planId={planId}
            showReserved
            onConnect={(path) => void startConnect(selection, path)}
            onInstall={(bay) =>
              setInstallBay({ deviceId: selection.deviceId!, ...bay })
            }
            onEditPart={(part) =>
              setPartEdit({ deviceId: selection.deviceId!, ...part })
            }
          />
        )}
      {selCabinetDevice && selection?.deviceId && (
        <CabinetDeviceHud
          cabinet={selCabinetDevice}
          deviceId={selection.deviceId}
          pinned
          focus={{ on: focusOn, onToggle: () => setFocusOn((v) => !v) }}
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
      {/* Isolation pill - hidden racks must read as "isolated", never as
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
          device={selDevice}
          position={rackPortPosition(selTile, selDevice)}
          selection={selection}
          onConnect={(path) => void startConnect(selection, path)}
          onInstall={(bay) => setInstallBay({ deviceId: selDevice.id, ...bay })}
          onEditPart={(part) =>
            setPartEdit({ deviceId: selDevice.id, ...part })
          }
        />
      )}
      {cableSel && <CableHud planId={planId} cableId={cableSel} />}
      <PartMarkerMenu menu={partMenu} onClose={() => setPartMenu(null)} />
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
      {/* Cable creator - seeded with the picked end(s); on save we just close
          and stay in the room view (occupancy + paths re-fetch). */}
      <Dialog open={!!modal} onOpenChange={(o) => !o && setModal(null)}>
        <DialogContent size="xl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Connect cable</DialogTitle>
          </DialogHeader>
          {modal && (
            <>
              {/* Routing - point-to-point (same-rack patch) or through the
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
                        - patch inside the rack / straight run
                      </span>
                    </label>
                  </div>
                  <div className="flex items-center gap-2 text-[13px]">
                    <RadioGroupItem value="trays" id="cable-routing-trays" />
                    <label htmlFor="cable-routing-trays">
                      Through ducts
                      <span className="text-muted-foreground">
                        {" "}
                        - ride the plan's cable trays
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
                      No ducts on this plan yet - draw trays in the 2D Cables
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
      {/* Module install / part editor for marker clicks - the same dialogs the
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
      {/* The SAME key the 2D faceplate uses, keyed to what the near-tier
          devices actually draw - so it's absent until a photo panel with real
          ports is in view, and then explains only those colours - in the maps'
          legend frame. The overlay toggles live in the route's View popover. */}
      {!legendIsEmpty(legend) && (
        <div className="absolute top-3 right-3">
          <LegendFrame storageKey="floorplan:3d-legend" className="w-fit">
            <FaceplateLegend observed content={legend} />
          </LegendFrame>
        </div>
      )}
    </div>
  )
}

/**
 * Overlay card for a cable clicked in the cables layer - identity, both ends
 * (device:port, each a jump-off), length, and the run trace.
 */
/**
 * An opened tray: what actually rides through it. Clicking a tray in the room
 * is the natural "show me this duct's contents" gesture, and without this the
 * basket was scenery - you could see runs pass through but never ask which.
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
            Nothing routed through this tray yet - a cable follows it once its
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
  // or a bug - the answer is almost always "it's point-to-point".
  const scene = useScene(planId)
  const paths = useCablePaths(planId)
  const path = paths.data?.cables.find((p) => p.id === cableId)
  const followed = (path?.tray_ids ?? [])
    .map((id) => scene.data?.trays.find((t) => t.id === id))
    .filter((t): t is SceneTray => Boolean(t))
  // An end with no port marker on its device type is drawn at the panel's
  // centre; say so here rather than let the run look mis-routed.
  const anchored =
    scene.data && path ? cableEndsAnchored(scene.data, path) : null
  const unanchored = anchored
    ? !anchored[0] && !anchored[1]
      ? "Both ends have"
      : !anchored[0]
        ? "The A end has"
        : !anchored[1]
          ? "The B end has"
          : null
    : null
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
          className="link min-w-0 font-mono break-words text-foreground"
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
        <Loading className="min-h-16" />
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
            {unanchored && (
              <span className="text-[11px] text-muted-foreground">
                {unanchored} no port marker on the device type, so the run is
                drawn at the panel centre.
              </span>
            )}
            <div className="grid gap-0.5">
              <span className="text-[10px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
                Routing
              </span>
              {followed.length === 0 ? (
                <span className="text-muted-foreground">
                  Point-to-point - follows no tray
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
            <OpenLink to="/cables/$id" params={{ id: c.id }} className="flex-1">
              Open cable
            </OpenLink>
            <BarButton asChild className="flex-1">
              <Link
                to="/floorplans/$id"
                params={{ id: planId }}
                search={{ viz: "3d" as const, trace: c.id }}
              >
                Trace run
              </Link>
            </BarButton>
          </div>
        </>
      )}
    </div>
  )
}
