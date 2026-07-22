import { useMemo, useRef } from "react"
import { useFrame, useThree } from "@react-three/fiber"
import { Line } from "@react-three/drei"
import type { Line2 } from "three-stdlib"
import { useQuery } from "@tanstack/react-query"

import { api, type FloorPlanCablePath } from "@/lib/api"
import { routeCable, type Pt } from "@/components/floorplan/cable-route"

import {
  cellToWorld,
  rackFootprintM,
  trayElevationM,
  type ScenePayload,
} from "./world"

/**
 * A traced cable drawn through the room: the SAME 2D route the flat canvas
 * computes (`routeCable` over the assigned trays), lifted to the trays'
 * elevation with vertical drops into both endpoint racks, animated as a
 * marching dashed line so the run direction reads at a glance.
 */
export function CableTrace3D({
  planId,
  scene,
  cableId,
}: {
  planId: string
  scene: ScenePayload
  cableId: string
}) {
  // Same endpoint (and query key) the 2D canvas uses — switching views is free.
  const paths = useQuery({
    queryKey: ["floor-plan-cable-paths", planId],
    queryFn: () =>
      api<{ cables: FloorPlanCablePath[] }>(
        `/api/floor-plans/${planId}/cable-paths/`
      ),
    staleTime: 60_000,
  })

  const cp = paths.data?.cables.find((c) => c.id === cableId)

  const points = useMemo(() => {
    if (!cp) return null
    const { plan } = scene
    const tileCentre = (tileId: string): Pt | null => {
      const t = scene.tiles.find((x) => x.id === tileId)
      return t ? [t.x + t.w / 2, t.y + t.h / 2] : null
    }
    const a = cp.a_tiles[0] ? tileCentre(cp.a_tiles[0]) : null
    const b = cp.b_tiles[0] ? tileCentre(cp.b_tiles[0]) : null
    if (!a || !b) return null

    const trays = scene.trays.filter((t) => cp.tray_ids.includes(t.id))
    const route = routeCable(a, b, trays.map((t) => t.points))
    // Ride at the assigned trays' (average) elevation; straight runs with no
    // tray fly at 2/3 room height so they read as an abstract link.
    const rideY = trays.length
      ? trays.reduce((s, t) => s + trayElevationM(plan, t), 0) / trays.length
      : (plan.ceiling_mm / 1000) * 0.66

    const endY = (tileId: string): number => {
      const t = scene.tiles.find((x) => x.id === tileId)
      if (t?.rack) return rackFootprintM(t.rack).height * 0.7
      return 0.8
    }

    const pts: [number, number, number][] = []
    const [ax, az] = cellToWorld(plan, route[0][0], route[0][1])
    pts.push([ax, endY(cp.a_tiles[0]), az]) // leave the A cabinet…
    for (const p of route) {
      const [x, z] = cellToWorld(plan, p[0], p[1])
      pts.push([x, rideY, z]) // …ride the trays…
    }
    const last = route[route.length - 1]
    const [bx, bz] = cellToWorld(plan, last[0], last[1])
    pts.push([bx, endY(cp.b_tiles[0]), bz]) // …drop into the B cabinet.
    return pts
  }, [cp, scene])

  if (!points) return null
  return <MarchingLine points={points} color={cp?.color || "#0ea5e9"} />
}

function MarchingLine({
  points,
  color,
}: {
  points: [number, number, number][]
  color: string
}) {
  const ref = useRef<Line2>(null)
  const invalidate = useThree((s) => s.invalidate)
  useFrame((_, delta) => {
    const mat = ref.current?.material
    if (mat && "dashOffset" in mat) {
      ;(mat as { dashOffset: number }).dashOffset -= delta * 0.6
      invalidate()
    }
  })
  return (
    <Line
      ref={ref}
      points={points}
      color={color}
      lineWidth={3}
      dashed
      dashSize={0.25}
      gapSize={0.12}
    />
  )
}
