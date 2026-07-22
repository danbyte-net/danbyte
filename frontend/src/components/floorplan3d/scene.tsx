import { useMemo, useRef, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { Link } from "@tanstack/react-router"

import type { FloorPlanLiveState } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

import { CableTrace3D } from "./cable-trace-3d"
import { CameraRig, type FlyToRequest } from "./camera-rig"
import { Room } from "./room"
import { RackMesh, type Sel } from "./rack-mesh"
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
}: {
  planId: string
  liveState: FloorPlanLiveState | null
  traceCableId?: string | null
}) {
  const scene = useScene(planId)
  const [selection, setSelection] = useState<Sel | null>(null)
  const flyToRef = useRef<FlyToRequest | null>(null)

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
    selection?.kind === "device" && selTile
      ? (selTile.rack!.devices.find((x) => x.id === selection.deviceId) ?? null)
      : null

  return (
    <div className="relative h-full min-h-0 w-full">
      <Canvas
        frameloop="demand"
        dpr={[1, 1.75]}
        camera={{
          position: [w / 2 + diag * 0.55, diag * 0.6, d + diag * 0.45],
          fov: 45,
          near: 0.1,
          far: diag * 10 + 50,
        }}
        onPointerMissed={() => setSelection(null)}
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
            onSelect={setSelection}
            onFlyTo={(target, position) => {
              flyToRef.current = { target, position }
            }}
          />
        ))}
        {data.trays.map((tr) => (
          <TrayMesh key={tr.id} plan={plan} tray={tr} />
        ))}
        {traceCableId && (
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
      {selTile && selDevice && <DeviceHud tile={selTile} dev={selDevice} />}
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
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  )
  return (
    <div className="absolute top-3 left-3 w-64 rounded-lg border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[13px] font-semibold">
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
          row("Primary IP", <span className="font-mono">{dev.primary_ip}</span>)}
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
