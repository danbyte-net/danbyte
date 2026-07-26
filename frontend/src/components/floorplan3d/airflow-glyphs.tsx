import { useLayoutEffect, useMemo, useRef } from "react"
import * as THREE from "three"

import { AIRFLOW_HEX, EMPTY_LEGEND } from "@/lib/faceplate-colors"
import { useReportLegend } from "@/components/speed-scale"
import type { LegendReporter } from "@/components/speed-scale"

import {
  GLYPH_UNIT_H_M,
  airflowGlyphPlacements,
  deviceBoxM,
  rackFootprintM,
} from "./world"
import type { SceneRack } from "./world"

// The UNIT cone every instance scales from — each glyph carries its own
// factor, sized to the device it annotates (world.airflowGlyphSizeM). A fixed
// 50 mm cone was wider than the 42 mm 1U box it belonged to, and up close it
// sat over the faceplate and hid the ports. 8 radial segments — dozens of
// instances per rack.
const CONE_H = GLYPH_UNIT_H_M
const CONE_R = CONE_H * 0.42
const UP = new THREE.Vector3(0, 1, 0)

/**
 * The rack's airflow layer: every device's intake/exhaust cones as two
 * InstancedMeshes (one per colour). Static — matrices are set once per data
 * change, which invalidates by itself under the demand frameloop. Decoration:
 * never raycast, so it can't steal device/port clicks.
 *
 * Mounted from RackMesh's NEAR tier only, so it inherits the existing LOD
 * hysteresis instead of growing its own distance logic.
 */
export function AirflowGlyphs({
  rack,
  legendKey,
  onLegend,
}: {
  rack: SceneRack
  /** Stable collector key (the rack tile id). */
  legendKey: string
  onLegend?: LegendReporter
}) {
  const intakeRef = useRef<THREE.InstancedMesh>(null)
  const exhaustRef = useRef<THREE.InstancedMesh>(null)

  const { intake, exhaust } = useMemo(() => {
    const { width, depth } = rackFootprintM(rack)
    const all = rack.devices.flatMap((d) =>
      airflowGlyphPlacements(d.airflow, deviceBoxM(rack, d, width, depth))
    )
    return {
      intake: all.filter((g) => g.kind === "intake"),
      exhaust: all.filter((g) => g.kind === "exhaust"),
    }
  }, [rack])

  useLayoutEffect(() => {
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion()
    const dir = new THREE.Vector3()
    const pos = new THREE.Vector3()
    const scale = new THREE.Vector3()
    for (const [ref, glyphs] of [
      [intakeRef, intake],
      [exhaustRef, exhaust],
    ] as const) {
      const mesh = ref.current
      if (!mesh) continue
      glyphs.forEach((g, i) => {
        // Cones point +Y by default; rotate that axis onto the flow direction,
        // then shrink the unit cone to this device's size.
        q.setFromUnitVectors(UP, dir.set(...g.dir))
        mesh.setMatrixAt(
          i,
          m.compose(pos.set(...g.pos), q, scale.setScalar(g.scale))
        )
      })
      mesh.instanceMatrix.needsUpdate = true
    }
  }, [intake, exhaust])

  // The room legend keys what's on screen: report only the kinds drawn,
  // retract on unmount (toggle off / far tier). Value-compared upstream.
  const legend = useMemo(() => {
    const airflow = new Set<string>()
    if (intake.length) airflow.add("intake")
    if (exhaust.length) airflow.add("exhaust")
    return { ...EMPTY_LEGEND, airflow }
  }, [intake.length, exhaust.length])
  useReportLegend(onLegend, `airflow:${legendKey}`, legend)

  if (intake.length === 0 && exhaust.length === 0) return null
  return (
    <group>
      {intake.length > 0 && (
        <instancedMesh
          ref={intakeRef}
          args={[undefined, undefined, intake.length]}
          raycast={() => null}
        >
          <coneGeometry args={[CONE_R, CONE_H, 8]} />
          <meshBasicMaterial
            color={AIRFLOW_HEX.intake}
            toneMapped={false}
            transparent
            opacity={0.9}
          />
        </instancedMesh>
      )}
      {exhaust.length > 0 && (
        <instancedMesh
          ref={exhaustRef}
          args={[undefined, undefined, exhaust.length]}
          raycast={() => null}
        >
          <coneGeometry args={[CONE_R, CONE_H, 8]} />
          <meshBasicMaterial
            color={AIRFLOW_HEX.exhaust}
            toneMapped={false}
            transparent
            opacity={0.9}
          />
        </instancedMesh>
      )}
    </group>
  )
}
