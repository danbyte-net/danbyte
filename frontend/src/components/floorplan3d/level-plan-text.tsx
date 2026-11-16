import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FloorPlan, FloorPlanContents } from "@/lib/api"
import type { ExplodeStore } from "@/components/floorplan/level-explode"
import { useTheme } from "@/components/theme-provider"
import { readFloorHidden, visibleShapes } from "@/components/floorplan/hidden"
import { shapesOf } from "@/components/floorplan/shapes"
import type { AreaShape, LabelShape } from "@/components/floorplan/shapes"
import { floorPlanContentsKey } from "@/components/floorplan/use-floor-plan-data"

import type { LevelPlacement } from "./building-math"
import { ExplodedGroup } from "./level-explode-3d"
import { planTexts } from "./plan-text"
import type { PlanTextShow } from "./plan-text"
import type { PlanTextBus } from "./plan-text-bus"
import { PlanTextLayer } from "./plan-text-layer"
import { useScene } from "./use-scene"

/**
 * Another level's plan text in a building: its labels, room, area, zone
 * and tray names on its own floor, at its elevation - moving with the
 * explode slider, gone with the level. It reads the level's areas and
 * labels (the query its own editor uses) and leaves out what that level's
 * eyes hide.
 */
export function LevelPlanText({
  placement,
  explode = null,
  bus,
  show,
  readable,
}: {
  placement: LevelPlacement
  /** The building's explode: the text rides its level's group. */
  explode?: ExplodeStore | null
  bus: PlanTextBus
  show: PlanTextShow
  readable: boolean
}) {
  const id = placement.floor.id
  const scene = useScene(id)
  const contents = useQuery({
    queryKey: floorPlanContentsKey(id),
    queryFn: () => api<FloorPlanContents>(`/api/floor-plans/${id}/contents/`),
    staleTime: 30_000,
  })
  const plan = useQuery({
    queryKey: ["floor-plan", id],
    queryFn: () => api<FloorPlan>(`/api/floor-plans/${id}/`),
    staleTime: 30_000,
  })
  const dark = useTheme().theme === "dark"
  const data = scene.data
  const hiddenRaw = plan.data?.state.hidden
  const items = useMemo(() => {
    if (!data || !contents.data) return []
    const hidden = readFloorHidden(hiddenRaw)
    const shapes = visibleShapes(
      shapesOf(contents.data.areas, contents.data.labels),
      hidden
    )
    return planTexts({
      scene: {
        ...data,
        tiles: data.tiles.filter((t) => !hidden.tiles.includes(t.id)),
      },
      areas: shapes.filter((s): s is AreaShape => s.kind === "area"),
      labels: shapes.filter((s): s is LabelShape => s.kind === "label"),
      show,
      dark,
    })
  }, [data, contents.data, hiddenRaw, show, dark])
  if (!data) return null
  return (
    <ExplodedGroup explode={explode} step={placement.step}>
      <PlanTextLayer
        bus={bus}
        items={items}
        plan={data.plan}
        place={placement}
        readable={readable}
        idPrefix={`${id}:`}
        walls={data.walls}
      />
    </ExplodedGroup>
  )
}
