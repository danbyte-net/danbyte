import type { ReactNode } from "react"
import {
  Ellipsis,
  Grid3x3,
  Image as ImageIcon,
  Layers,
  Maximize,
  PanelBottom,
  PanelRight,
  Settings2,
} from "lucide-react"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"
import {
  BarButton,
  BarIconButton,
  BarMenuTrigger,
  BarToggle,
} from "@/components/map-toolbar"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { HistoryButtons } from "@/components/topology/history-buttons"

import { DisplayMenu } from "./display-menu"
import { TileSearch } from "./tile-search"
import type { EditorMode } from "./use-plan-edit-state"
import type { PlanViewPrefs } from "./use-plan-view-prefs"

/** Second-bar controls that move into More once the bar is narrower than
 * 52rem - never at 1280px with the app sidebar open, only on a narrower
 * window - so nothing on the bar is ever clipped or scrolled out of sight. */
const WIDE_ONLY = "hidden @min-[52rem]:inline-flex"
const NARROW_ONLY = "@min-[52rem]:hidden"

/** The editor's second bar: find and view on the left, the panel, display
 * and file actions on the right - the topology map's split. */
export function PlanToolbar({
  plan,
  mode,
  view3d,
  canEdit,
  tiles,
  search,
  onSearchChange,
  onPickTile,
  onFit,
  showGrid,
  onShowGridChange,
  prefs,
  hasRacks,
  drawingOpen,
  onToggleDrawing,
  backgroundControls,
  exportMenu,
  onOpenSettings,
  onOpenBackground,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  isDirty,
  saving,
  onSave,
}: {
  plan: FloorPlan
  mode: EditorMode
  view3d: boolean
  canEdit: boolean
  /** The tiles on the plan (not hidden) - what Find searches. */
  tiles: FloorPlanTile[]
  search: string
  onSearchChange: (v: string) => void
  onPickTile: (tile: FloorPlanTile) => void
  onFit: () => void
  showGrid: boolean
  onShowGridChange: (v: boolean) => void
  prefs: PlanViewPrefs
  /** The plan holds racks - the rack table can open. */
  hasRacks: boolean
  drawingOpen: boolean
  onToggleDrawing: () => void
  backgroundControls: ReactNode
  exportMenu: ReactNode
  onOpenSettings: () => void
  onOpenBackground: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  isDirty: boolean
  saving: boolean
  onSave: () => void
}) {
  const { colorBy, showRacks, showObjects, setViewPref } = prefs
  return (
    // A container, so the overflow into More follows the bar's own width
    // (the app sidebar open or not) rather than the window's.
    <div className="@container flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 lg:px-6">
      {mode === "layout" && (
        <TileSearch
          tiles={tiles}
          value={search}
          onChange={onSearchChange}
          onPick={onPickTile}
        />
      )}
      <BarIconButton label="Fit to view" onClick={onFit}>
        <Maximize />
      </BarIconButton>
      <BarToggle
        pressed={showGrid}
        className={WIDE_ONLY}
        onClick={() => onShowGridChange(!showGrid)}
      >
        <Grid3x3 /> Grid
      </BarToggle>
      <div className="ml-auto flex items-center gap-2">
        {colorBy !== "type" && hasRacks && (
          <BarToggle
            pressed={showRacks}
            onClick={() => setViewPref("show_racks", !showRacks)}
          >
            <PanelBottom /> Racks
          </BarToggle>
        )}
        {plan.drawing && !view3d && (
          <BarToggle pressed={drawingOpen} onClick={onToggleDrawing}>
            <Layers /> Drawing
          </BarToggle>
        )}
        <BarToggle
          pressed={showObjects}
          onClick={() => setViewPref("show_objects", !showObjects)}
        >
          <PanelRight /> Objects
        </BarToggle>
        <DisplayMenu view3d={view3d} prefs={prefs} />
        {canEdit && (
          <Popover>
            <PopoverTrigger asChild>
              <BarMenuTrigger className={WIDE_ONLY}>
                <ImageIcon /> Background
              </BarMenuTrigger>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 gap-3 p-3">
              {backgroundControls}
            </PopoverContent>
          </Popover>
        )}
        {exportMenu}
        {canEdit && (
          <BarIconButton
            label="Plan settings"
            className={WIDE_ONLY}
            onClick={onOpenSettings}
          >
            <Settings2 />
          </BarIconButton>
        )}
        {/* What the wide header shows as its own buttons, gathered here
            when the header is too narrow for all of them. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <BarMenuTrigger className={NARROW_ONLY}>
              <Ellipsis /> More
            </BarMenuTrigger>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuCheckboxItem
              checked={showGrid}
              onCheckedChange={(v) => onShowGridChange(v)}
            >
              Grid
            </DropdownMenuCheckboxItem>
            {canEdit && <DropdownMenuSeparator />}
            {canEdit && (
              <DropdownMenuItem onSelect={onOpenBackground}>
                <ImageIcon /> Background…
              </DropdownMenuItem>
            )}
            {canEdit && (
              <DropdownMenuItem onSelect={onOpenSettings}>
                <Settings2 /> Plan settings…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        {canEdit && (
          <HistoryButtons
            canUndo={canUndo}
            canRedo={canRedo}
            onUndo={onUndo}
            onRedo={onRedo}
          />
        )}
        {canEdit && (
          <BarButton
            variant="default"
            disabled={!isDirty || saving}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save"}
          </BarButton>
        )}
      </div>
    </div>
  )
}
