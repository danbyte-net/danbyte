import { useEffect, useState } from "react"
import type { UseMutationResult } from "@tanstack/react-query"

import type { FloorPlan } from "@/lib/api"
import {
  storeCableLook,
  storeCableScale,
  storedCableLook,
  storedCableScale,
  storedQualitySetting,
  storeQualitySetting,
} from "@/lib/render-quality"
import type { CableLook, RenderQualitySetting } from "@/lib/render-quality"

import { readFloorHidden } from "./hidden"
import type { FloorHidden } from "./hidden"
import { readColorBy } from "./tile-paint"
import type { ColorBy } from "./tile-paint"

/** 3D cabinet-shell modes - persisted in plan.state.shell_3d; anything else
 * stored there falls back to cutaway. */
export const SHELL_MODES_3D = ["solid", "cutaway", "xray"] as const
export type ShellMode3D = (typeof SHELL_MODES_3D)[number]

export type ViewPrefKey =
  | "label_fit"
  | "show_fov"
  | "show_zone_labels"
  | "show_trays"
  | "show_cable_links"
  | "show_objects"
  | "show_3d_u"
  | "show_3d_names"
  | "show_3d_cables"
  | "show_3d_airflow"
  | "show_3d_floor_peek"
  | "show_3d_walls"
  | "show_3d_ceiling"
  | "show_3d_names_scope"
  | "show_3d_names_edge"
  | "color_by"
  | "show_racks"

/** The plan's view preferences: seeded from plan.state, a session override
 * on top, persisted back to the plan for editors. The 3D effects budget and
 * the cable look are per device instead (localStorage). */
export function usePlanViewPrefs({
  id,
  plan,
  canEdit,
  patchPlan,
}: {
  id: string
  plan: FloorPlan | undefined
  canEdit: boolean
  patchPlan: UseMutationResult<FloorPlan, Error, Record<string, unknown>>
}) {
  // View prefs - seeded from plan.state, persisted back for editors.
  const [labelFitLocal, setLabelFitLocal] = useState<boolean | null>(null)
  const [showFovLocal, setShowFovLocal] = useState<boolean | null>(null)
  const [showZoneLabelsLocal, setShowZoneLabelsLocal] = useState<
    boolean | null
  >(null)
  const [showTraysLocal, setShowTraysLocal] = useState<boolean | null>(null)
  const [showLinksLocal, setShowLinksLocal] = useState<boolean | null>(null)
  const [showObjectsLocal, setShowObjectsLocal] = useState<boolean | null>(null)
  // 3D overlay prefs - same persistence pattern as the 2D ones.
  const [show3dULocal, setShow3dULocal] = useState<boolean | null>(null)
  const [show3dNamesLocal, setShow3dNamesLocal] = useState<boolean | null>(null)
  const [names3dScopeLocal, setNames3dScopeLocal] = useState<
    "all" | "selected" | null
  >(null)
  const [names3dEdgeLocal, setNames3dEdgeLocal] = useState<boolean | null>(null)
  const [show3dCablesLocal, setShow3dCablesLocal] = useState<boolean | null>(
    null
  )
  const [show3dAirflowLocal, setShow3dAirflowLocal] = useState<boolean | null>(
    null
  )
  const [floorPeekLocal, setFloorPeekLocal] = useState<boolean | null>(null)
  const [show3dWallsLocal, setShow3dWallsLocal] = useState<boolean | null>(null)
  const [show3dCeilingLocal, setShow3dCeilingLocal] = useState<boolean | null>(
    null
  )
  // Cabinet shell (3D): solid / cutaway / x-ray - a mode, not a checkbox.
  const [shell3dLocal, setShell3dLocal] = useState<ShellMode3D | null>(null)
  // Color by (#247) and the rack table it opens - plan prefs like the rest.
  const [colorByLocal, setColorByLocal] = useState<ColorBy | null>(null)
  const [showRacksLocal, setShowRacksLocal] = useState<boolean | null>(null)
  // 3D effects budget - PER-DEVICE (localStorage), not a plan pref: the
  // workstation's High must not follow the plan onto a weak laptop.
  const [quality3d, setQuality3dState] = useState<RenderQualitySetting>(() =>
    storedQualitySetting()
  )
  const setQuality3d = (v: RenderQualitySetting) => {
    setQuality3dState(v)
    storeQualitySetting(v)
  }
  // Cable thickness in the room - per device too: a fat cable that reads on
  // a laptop at arm's length is a rope on a 4K wall screen.
  const [cableScale, setCableScaleState] = useState<number>(() =>
    storedCableScale()
  )
  const setCableScale = (v: number) => {
    setCableScaleState(v)
    storeCableScale(v)
  }
  const [cableLook, setCableLookState] = useState<CableLook>(() =>
    storedCableLook()
  )
  const setCableLook = (v: CableLook) => {
    setCableLookState(v)
    storeCableLook(v)
  }

  // Switching floors re-uses the mounted editor - one floor's session
  // overrides never bleed into another.
  useEffect(() => {
    setLabelFitLocal(null)
    setShowFovLocal(null)
    setShowTraysLocal(null)
    setShowLinksLocal(null)
    setShell3dLocal(null)
    setColorByLocal(null)
    setShowRacksLocal(null)
  }, [id])

  // View prefs: seeded from the plan's saved state; editors persist toggles.
  const labelFit = labelFitLocal ?? Boolean(plan?.state.label_fit)
  const showFov =
    showFovLocal ?? (plan?.state.show_fov as boolean | undefined) ?? true
  const showZoneLabels =
    showZoneLabelsLocal ??
    (plan?.state.show_zone_labels as boolean | undefined) ??
    true
  const showTrays =
    showTraysLocal ?? (plan?.state.show_trays as boolean | undefined) ?? true
  const showCableLinks =
    showLinksLocal ??
    (plan?.state.show_cable_links as boolean | undefined) ??
    false
  // The eyes (#hide): a type, a role or one tile off the plan. Lives on the
  // plan like the other view preferences, with the same session override,
  // and only ever narrows what is drawn - `tiles` (all of them) keeps
  // feeding the save path.
  const [hiddenLocal, setHiddenLocal] = useState<FloorHidden | null>(null)
  const hidden = hiddenLocal ?? readFloorHidden(plan?.state.hidden)
  const setHiddenPref = (next: FloorHidden) => {
    setHiddenLocal(next)
    if (canEdit && plan)
      patchPlan.mutate({ state: { ...plan.state, hidden: next } })
  }
  const showObjects =
    showObjectsLocal ??
    (plan?.state.show_objects as boolean | undefined) ??
    false
  const show3dU =
    show3dULocal ?? (plan?.state.show_3d_u as boolean | undefined) ?? false
  const show3dNames =
    show3dNamesLocal ??
    (plan?.state.show_3d_names as boolean | undefined) ??
    false
  const names3dScope =
    names3dScopeLocal ??
    (plan?.state.show_3d_names_scope as "all" | "selected" | undefined) ??
    "all"
  const names3dEdge =
    names3dEdgeLocal ??
    (plan?.state.show_3d_names_edge as boolean | undefined) ??
    false
  const show3dCables =
    show3dCablesLocal ??
    (plan?.state.show_3d_cables as boolean | undefined) ??
    false
  const show3dAirflow =
    show3dAirflowLocal ??
    (plan?.state.show_3d_airflow as boolean | undefined) ??
    false
  const floorPeek =
    floorPeekLocal ??
    (plan?.state.show_3d_floor_peek as boolean | undefined) ??
    false
  // Walls default ON: a wall someone drew must show up without a hunt
  // through the View popover - hiding the shell is the deliberate act.
  const show3dWalls =
    show3dWallsLocal ??
    (plan?.state.show_3d_walls as boolean | undefined) ??
    true
  const show3dCeiling =
    show3dCeilingLocal ??
    (plan?.state.show_3d_ceiling as boolean | undefined) ??
    false
  const shell3dRaw =
    shell3dLocal ?? (plan?.state.shell_3d as string | undefined) ?? "cutaway"
  const shell3d: ShellMode3D = SHELL_MODES_3D.includes(
    shell3dRaw as ShellMode3D
  )
    ? (shell3dRaw as ShellMode3D)
    : "cutaway"
  const setShellMode = (v: ShellMode3D) => {
    setShell3dLocal(v)
    if (canEdit && plan)
      patchPlan.mutate({ state: { ...plan.state, shell_3d: v } })
  }

  // Color by (#247): what rack tiles are coloured by, in 2D and in the 3D
  // room - Type, the default, is the plan as it always looked. A rack
  // measure brings the rack table up under the plan, which then lists the
  // racks the Objects sidebar otherwise would.
  const colorBy = colorByLocal ?? readColorBy(plan?.state.color_by)
  const showRacks =
    showRacksLocal ?? (plan?.state.show_racks as boolean | undefined) ?? true

  const setViewPref = (
    key: ViewPrefKey,
    value: boolean | "all" | "selected" | ColorBy
  ) => {
    if (key === "label_fit") setLabelFitLocal(value as boolean)
    else if (key === "color_by") setColorByLocal(value as ColorBy)
    else if (key === "show_racks") setShowRacksLocal(value as boolean)
    else if (key === "show_fov") setShowFovLocal(value as boolean)
    else if (key === "show_zone_labels")
      setShowZoneLabelsLocal(value as boolean)
    else if (key === "show_trays") setShowTraysLocal(value as boolean)
    else if (key === "show_objects") setShowObjectsLocal(value as boolean)
    else if (key === "show_3d_u") setShow3dULocal(value as boolean)
    else if (key === "show_3d_names") setShow3dNamesLocal(value as boolean)
    else if (key === "show_3d_cables") setShow3dCablesLocal(value as boolean)
    else if (key === "show_3d_airflow") setShow3dAirflowLocal(value as boolean)
    else if (key === "show_3d_floor_peek") setFloorPeekLocal(value as boolean)
    else if (key === "show_3d_walls") setShow3dWallsLocal(value as boolean)
    else if (key === "show_3d_ceiling") setShow3dCeilingLocal(value as boolean)
    else if (key === "show_3d_names_scope")
      setNames3dScopeLocal(value as "all" | "selected")
    else if (key === "show_3d_names_edge") setNames3dEdgeLocal(value as boolean)
    else setShowLinksLocal(value as boolean)
    if (canEdit && plan)
      patchPlan.mutate({ state: { ...plan.state, [key]: value } })
  }

  return {
    labelFit,
    showFov,
    showZoneLabels,
    showTrays,
    showCableLinks,
    /** Turn the cable links on for this session only (a trace). */
    setShowLinksLocal,
    hidden,
    setHiddenPref,
    showObjects,
    show3dU,
    show3dNames,
    names3dScope,
    names3dEdge,
    show3dCables,
    show3dAirflow,
    floorPeek,
    show3dWalls,
    show3dCeiling,
    shell3d,
    setShellMode,
    colorBy,
    showRacks,
    quality3d,
    setQuality3d,
    cableScale,
    setCableScale,
    cableLook,
    setCableLook,
    setViewPref,
  }
}

export type PlanViewPrefs = ReturnType<typeof usePlanViewPrefs>
