import { useEffect, useRef, useState } from "react"

import type { FloorPlanTile } from "@/lib/api"

import { cableDraftDirty } from "./cable-draft"
import { usePlanDraft } from "./edit-history"
import type { PaletteEntry } from "./floor-canvas"
import type { PlanShape } from "./shapes"

/** Local editing shape - server tiles plus unsaved ones (temp ids). */
export type EditTile = FloorPlanTile

/** What the canvas edits: layout (tiles, areas, labels), structure (walls,
 * raised floors), cables (trays). The tool in hand picks it. */
export type EditorMode = "layout" | "cable" | "structure"

/** The tool rail's tools. */
export type EditorTool =
  | "select"
  | "rect"
  | "polygon"
  | "label"
  | "tiles"
  | "structure"
  | "trays"
  | "snapshot"

/** The canvas mode a tool works in. */
export const TOOL_MODE: Record<EditorTool, EditorMode> = {
  select: "layout",
  rect: "layout",
  polygon: "layout",
  label: "layout",
  tiles: "layout",
  structure: "structure",
  trays: "cable",
  snapshot: "layout",
}

/** The same rows, as last saved: a refetch that brings nothing new. */
const sameRows = (
  a: readonly { id: string; updated_at: string }[],
  b: readonly { id: string; updated_at: string }[]
) =>
  a.length === b.length &&
  a.every((t, i) => t.id === b[i].id && t.updated_at === b[i].updated_at)

/** The editor's local state: the tile draft with its history, what is
 * selected and armed, the mode, the in-progress drawings and the open
 * panels. Reset when the page moves to another floor; hydrated from the
 * server tiles whenever nothing is unsaved. */
export function usePlanEditState(
  id: string,
  serverTiles: FloorPlanTile[] | undefined,
  serverShapes: PlanShape[] | undefined
) {
  // ── Local editing state ────────────────────────────────────────────────
  // The tiles, areas and labels as edited, which changed and which went:
  // the draft Save writes, with its undo history (edit-history.ts).
  const draft = usePlanDraft<EditTile, PlanShape>()
  const {
    tiles,
    shapes,
    dirtyIds,
    deletedIds,
    setTiles,
    setShapes,
    setDirtyIds,
    setDeletedIds,
  } = draft
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // The area or label selected (one at a time; a tile selection clears it).
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(null)
  // The tool in hand (Edit only) - the rail's tools.
  const [tool, setTool] = useState<EditorTool>("select")
  const [armed, setArmed] = useState<PaletteEntry | null>(null)
  // Structure mode: arm-to-draw a raised-floor rectangle + selection.
  const [areaArmed, setAreaArmed] = useState(false)
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null)
  // Structure mode: wall selection + "Add door" arm-and-click.
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null)
  const [doorArmed, setDoorArmed] = useState(false)
  // Layout QoL: Ctrl/⌘-click and Shift-drag build a multi-selection the bulk
  // bar (orientation, delete) acts on. Draft-level edits - Save persists.
  const [multiSel, setMultiSel] = useState<Set<string>>(new Set())
  const [paletteTab, setPaletteTab] = useState<"tiles" | "zones">("tiles")
  const [showGrid, setShowGrid] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [backgroundOpen, setBackgroundOpen] = useState(false)
  // The CAD drawing's panel over the canvas, and an image picked while the
  // plan has a drawing (which it replaces, after a confirm).
  const [drawingOpen, setDrawingOpen] = useState(false)
  const [pendingImage, setPendingImage] = useState<File | null>(null)
  // Deep view: the rack/device contents + end-to-end trace side sheet.
  const [deepTile, setDeepTile] = useState<FloorPlanTile | null>(null)
  // A cabinet tile's panel over the canvas: its plate and devices.
  const [cabinetTileId, setCabinetTileId] = useState<string | null>(null)
  // A rack table row clicked in 3D: the room selects that rack and flies
  // to it (a new count each click, so the same row flies again).
  const [rackFocus3d, setRackFocus3d] = useState<{
    tileId: string
    n: number
  } | null>(null)
  const [show3dHint, setShow3dHint] = useState(true)
  const [highlightCableIds, setHighlightCableIds] = useState<string[]>([])
  // Tray edit mode: hide cables + let every tray be reshaped. A toggle.
  const [trayEditMode, setTrayEditMode] = useState(false)
  // Editor mode: layout (tiles) vs cable (trays).
  const [mode, setMode] = useState<EditorMode>("layout")
  const [selectedTrayId, setSelectedTrayId] = useState<string | null>(null)
  // Tray drawing: null when idle, else the in-progress vertex list.
  const [drawPoints, setDrawPoints] = useState<[number, number][] | null>(null)
  // Finished-but-unnamed tray awaiting its name.
  const [namingPoints, setNamingPoints] = useState<[number, number][] | null>(
    null
  )
  const [search, setSearch] = useState("")

  // Cable routes applied from "After placing" are unsaved edits too.
  const isDirty =
    dirtyIds.size > 0 || deletedIds.size > 0 || cableDraftDirty(draft.cables)
  const isDirtyRef = useRef(isDirty)
  isDirtyRef.current = isDirty

  // Switching floors re-uses this mounted component - reset every bit of
  // editor state so one floor's unsaved edits can never bleed into another.
  useEffect(() => {
    draft.load([])
    setMultiSel(new Set())
    setSelectedId(null)
    setSelectedShapeId(null)
    setTool("select")
    setArmed(null)
    setDeepTile(null)
    setCabinetTileId(null)
    setMode("layout")
    setSelectedTrayId(null)
    setDrawPoints(null)
    setNamingPoints(null)
    setHighlightCableIds([])
    setTrayEditMode(false)
    setAreaArmed(false)
    setSelectedAreaId(null)
    setSelectedWallId(null)
    setDoorArmed(false)
    setRackFocus3d(null)
    setDrawingOpen(false)
    setPendingImage(null)
  }, [id])

  // Hydrate local tiles from the server whenever fresh data lands and we
  // have no unsaved edits (so a background refetch never clobbers work).
  // The same tiles again (a refetch on focus) keep the undo history.
  useEffect(() => {
    if (serverTiles && !isDirtyRef.current) {
      const fresh = serverTiles
      const freshShapes = serverShapes ?? []
      if (!sameRows(draft.tiles, fresh) || !sameRows(draft.shapes, freshShapes))
        draft.load(fresh, freshShapes)
    }
    // Only fresh data hydrates; the draft is read, not watched.
  }, [serverTiles, serverShapes])

  // A step that removed a selected tile (undoing its placement) drops it
  // from the selection.
  useEffect(() => {
    const ids = new Set(tiles.map((t) => t.id))
    setMultiSel((prev) =>
      [...prev].every((tid) => ids.has(tid))
        ? prev
        : new Set([...prev].filter((tid) => ids.has(tid)))
    )
    if (ids.size) setSelectedId((cur) => (cur && !ids.has(cur) ? null : cur))
  }, [tiles])
  useEffect(() => {
    setSelectedShapeId((cur) =>
      cur && !shapes.some((s) => s.id === cur) ? null : cur
    )
  }, [shapes])

  return {
    draft,
    tiles,
    shapes,
    dirtyIds,
    deletedIds,
    setTiles,
    setShapes,
    setDirtyIds,
    setDeletedIds,
    isDirty,
    isDirtyRef,
    selectedId,
    setSelectedId,
    selectedShapeId,
    setSelectedShapeId,
    tool,
    setTool,
    armed,
    setArmed,
    areaArmed,
    setAreaArmed,
    selectedAreaId,
    setSelectedAreaId,
    selectedWallId,
    setSelectedWallId,
    doorArmed,
    setDoorArmed,
    multiSel,
    setMultiSel,
    paletteTab,
    setPaletteTab,
    showGrid,
    setShowGrid,
    settingsOpen,
    setSettingsOpen,
    backgroundOpen,
    setBackgroundOpen,
    drawingOpen,
    setDrawingOpen,
    pendingImage,
    setPendingImage,
    deepTile,
    setDeepTile,
    cabinetTileId,
    setCabinetTileId,
    rackFocus3d,
    setRackFocus3d,
    show3dHint,
    setShow3dHint,
    highlightCableIds,
    setHighlightCableIds,
    trayEditMode,
    setTrayEditMode,
    mode,
    setMode,
    selectedTrayId,
    setSelectedTrayId,
    drawPoints,
    setDrawPoints,
    namingPoints,
    setNamingPoints,
    search,
    setSearch,
  }
}

export type PlanEditState = ReturnType<typeof usePlanEditState>
