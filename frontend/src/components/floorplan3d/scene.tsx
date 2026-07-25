import { useEffect, useMemo, useRef, useState } from "react"
import { TriangleAlert } from "lucide-react"
import { Canvas } from "@react-three/fiber"
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

import { CablesLayer, CableTrace3D } from "./cable-trace-3d"
import { CameraRig, type FlyToRequest } from "./camera-rig"
import { Room } from "./room"
import { RackMesh, type Sel } from "./rack-mesh"
import { RaisedFloorMesh } from "./raised-floor-mesh"
import { TrayMesh } from "./tray-mesh"
import { useScene } from "./use-scene"
import {
  cellToWorld,
  webglSupported,
  type SceneDevice,
  type SceneTile,
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
}) {
  const scene = useScene(planId)
  const qc = useQueryClient()
  const [selection, setSelection] = useState<Sel | null>(null)
  const [cableSel, setCableSel] = useState<string | null>(null)
  const flyToRef = useRef<FlyToRequest | null>(null)

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

  // Every near-tier device reports the colours it draws; the HUD legend keys
  // their union (and hides when nothing photo-anchored is in view). Above the
  // WebGL/loading early returns — hook order has to be unconditional.
  const { content: legend, report: onLegend } = useLegendCollector()
  const supported = useMemo(webglSupported, [])
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

  const selTile = selection
    ? (rackTiles.find((t) => t.id === selection.tileId) ?? null)
    : null
  const selDevice =
    (selection?.kind === "device" || selection?.kind === "port") && selTile
      ? (selTile.rack!.devices.find((x) => x.id === selection.deviceId) ?? null)
      : null

  return (
    <div className="relative h-full min-h-0 w-full">
      <Canvas
        frameloop="demand"
        // Render at the display's real pixel ratio (capped at 2): 1.75 left a
        // HiDPI canvas rendering below native and reading softer than the 2D
        // faceplate beside it.
        dpr={[1, 2]}
        camera={{
          position: [w / 2 + diag * 0.55, diag * 0.6, d + diag * 0.45],
          fov: 45,
          near: 0.1,
          far: diag * 10 + 50,
        }}
        onPointerMissed={() => {
          setSelection(null)
          setConnecting(null)
          setCableSel(null)
        }}
      >
        <ambientLight intensity={0.7} />
        <directionalLight position={[w * 0.3, 12, d * 0.2]} intensity={1.1} />
        <directionalLight position={[w, 8, d]} intensity={0.4} />
        <Room scene={data} />
        {rackTiles.map((t) => (
          <RackMesh
            key={t.id}
            plan={plan}
            tile={t}
            check={liveState?.tiles[t.id]?.check ?? null}
            selection={selection}
            showUNumbers={showUNumbers}
            showNames={showNames}
            showAirflow={showAirflow}
            onSelect={handleSelect}
            onLegend={onLegend}
            onFlyTo={(target, position) => {
              flyToRef.current = { target, position }
            }}
          />
        ))}
        {data.trays.map((tr) => (
          <TrayMesh
            key={tr.id}
            plan={plan}
            tray={tr}
            areas={scene.data.raised_floors}
          />
        ))}
        {(scene.data.raised_floors ?? []).map((a) => (
          <RaisedFloorMesh key={a.id} plan={plan} area={a} peek={floorPeek} />
        ))}
        {showCables && (
          <CablesLayer
            planId={planId}
            scene={data}
            selectedId={cableSel}
            onSelect={(id) => {
              setSelection(null)
              setCableSel(id)
            }}
          />
        )}
        {traceCableId && traceCableId !== cableSel && (
          <CableTrace3D planId={planId} scene={data} cableId={traceCableId} />
        )}
        <CameraRig
          target={[w / 2, 0.8, d / 2]}
          maxDistance={diag * 4 + 20}
          requestRef={flyToRef}
        />
      </Canvas>
      {selTile && selection?.kind === "rack" && (
        <RackHud tile={selTile} liveState={liveState} />
      )}
      {selTile && selDevice && selection?.kind === "device" && (
        <DeviceHud tile={selTile} dev={selDevice} />
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

/** Overlay card for the selected rack — name, live rollup, jump-off. */
function RackHud({
  tile,
  liveState,
}: {
  tile: SceneTile
  liveState: FloorPlanLiveState | null
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
      <Button size="sm" variant="outline" asChild className="mt-2 h-7 w-full">
        <Link to="/racks/$id" params={{ id: rack.id }}>
          Open rack →
        </Link>
      </Button>
    </div>
  )
}

/** Overlay card for a selected device — identity, status, where it sits. */
function DeviceHud({ tile, dev }: { tile: SceneTile; dev: SceneDevice }) {
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
          `${rack.name} · U${dev.position}` +
            (dev.u_height > 1 ? `–${dev.position + dev.u_height - 1}` : "")
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
      <Button size="sm" variant="outline" asChild className="mt-2 h-7 w-full">
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
        {row("Position", `${rack.name} · U${dev.position}`)}
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
function CableHud({ planId, cableId }: { planId: string; cableId: string }) {
  const cable = useQuery({
    queryKey: ["cable", cableId],
    queryFn: () => api<Cable>(`/api/cables/${cableId}/`),
    staleTime: 30_000,
  })
  const c = cable.data
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
