import { useMemo, useState } from "react"
import { Canvas } from "@react-three/fiber"
import { OrbitControls } from "@react-three/drei"
import { Link } from "@tanstack/react-router"

import type { FloorPlanLiveState } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"

import { Room } from "./room"
import { RackMesh } from "./rack-mesh"
import { TrayMesh } from "./tray-mesh"
import { useScene } from "./use-scene"
import { cellToWorld, webglSupported, type SceneTile } from "./world"

/**
 * The 3D room view — the floor plan extruded into a navigable scene: racks as
 * cabinets at their tile positions (devices at true U positions up close),
 * trays at their recorded elevations, monitoring beacons from the same
 * `/state/` poll the 2D canvas uses.
 *
 * This module (and everything under `floorplan3d/`) is the ONLY place three.js
 * may be imported; the route loads it via `React.lazy` so the 3D stack stays
 * in its own chunk. Default export for `lazy()`.
 */
export default function FloorScene3D({
  planId,
  liveState,
}: {
  planId: string
  liveState: FloorPlanLiveState | null
}) {
  const scene = useScene(planId)
  const [selectedId, setSelectedId] = useState<string | null>(null)

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
  const selected = rackTiles.find((t) => t.id === selectedId) ?? null
  const diag = Math.max(w, d)

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
        onPointerMissed={() => setSelectedId(null)}
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
            selected={t.id === selectedId}
            onSelect={setSelectedId}
          />
        ))}
        {data.trays.map((tr) => (
          <TrayMesh key={tr.id} plan={plan} tray={tr} />
        ))}
        <OrbitControls
          makeDefault
          target={[w / 2, 0.8, d / 2]}
          maxPolarAngle={Math.PI / 2 - 0.02}
          minDistance={0.5}
          maxDistance={diag * 4 + 20}
        />
      </Canvas>
      {selected && <SelectionHud tile={selected} liveState={liveState} />}
    </div>
  )
}

/** Small overlay panel for the selected rack — name, live rollup, jump-off. */
function SelectionHud({
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
      </div>
      <Button size="sm" variant="outline" asChild className="mt-2 h-7 w-full">
        <Link to="/racks/$id" params={{ id: rack.id }}>
          Open rack →
        </Link>
      </Button>
    </div>
  )
}

