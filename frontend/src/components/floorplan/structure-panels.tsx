import { Trash2 } from "lucide-react"
import { useState } from "react"

import type {
  FloorPlanWall,
  FloorPlanWallOpening,
  RaisedFloorArea,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorPicker } from "@/components/ui/color-picker"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

import { WALL_DEFAULT_MM } from "./structure"

/** Structure-mode left rail - raised-floor areas + walls, each with its own
 * draw control. One rail, two catalogs: both are room construction. */
export function StructureRail({
  areas,
  selectedAreaId,
  drawing,
  onSelectArea,
  onStartDraw,
  onCancelDraw,
  walls,
  selectedWallId,
  wallDrawing,
  onSelectWall,
  onStartWallDraw,
  onCancelWallDraw,
}: {
  areas: RaisedFloorArea[]
  selectedAreaId: string | null
  drawing: boolean
  onSelectArea: (id: string | null) => void
  onStartDraw: () => void
  onCancelDraw: () => void
  walls: FloorPlanWall[]
  selectedWallId: string | null
  wallDrawing: boolean
  onSelectWall: (id: string | null) => void
  onStartWallDraw: () => void
  onCancelWallDraw: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Raised floors
        </span>
      </div>
      <div className="px-3 pb-2">
        {drawing ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onCancelDraw}
            >
              Cancel drawing
            </Button>
            <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
              Drag a rectangle on the grid. Esc cancels.
            </p>
          </>
        ) : (
          <Button size="sm" className="w-full" onClick={onStartDraw}>
            Draw area
          </Button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {areas.length === 0 && !drawing && (
          <p className="px-1.5 py-2 text-xs text-muted-foreground">
            No raised floors yet. Draw one - underfloor trays and cables will
            dive as deep as its plenum, and the 3D room shows the void.
          </p>
        )}
        {areas.map((a) => (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelectArea(a.id === selectedAreaId ? null : a.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-muted/60",
              a.id === selectedAreaId && "bg-muted"
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-dashed"
              style={{ borderColor: a.color || "#71717a" }}
            />
            <span className="min-w-0 flex-1 truncate">
              {a.label || "Raised floor"}
            </span>
            <span className="num text-[10px] text-muted-foreground">
              {a.width}×{a.height} · {a.plenum_mm} mm
            </span>
          </button>
        ))}

        <div className="mt-2 flex items-center justify-between px-1.5 pt-2 pb-1">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Walls
          </span>
        </div>
        <div className="px-1.5 pb-2">
          {wallDrawing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={onCancelWallDraw}
              >
                Cancel drawing
              </Button>
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
                Click the corners. Double-click or Enter finishes; Esc
                cancels.
              </p>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={onStartWallDraw}
            >
              Draw wall
            </Button>
          )}
        </div>
        {walls.length === 0 && !wallDrawing && (
          <p className="px-1.5 py-1 text-xs text-muted-foreground">
            No walls yet. Draw them, or right-click a room: Add walls around
            this.
          </p>
        )}
        {walls.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onSelectWall(w.id === selectedWallId ? null : w.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs hover:bg-muted/60",
              w.id === selectedWallId && "bg-muted"
            )}
          >
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-[3px]"
              style={{ background: w.color || "#52525b" }}
            />
            <span className="min-w-0 flex-1 truncate">{w.label || "Wall"}</span>
            <span className="num text-[10px] text-muted-foreground">
              {Math.max(0, w.points.length - 1)} seg
              {w.openings.length > 0
                ? ` · ${w.openings.length} door${w.openings.length === 1 ? "" : "s"}`
                : ""}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

/** Structure-mode right panel: edit the selected wall - label, height, color,
 * and its doors (place by arm-and-click, tune or remove here). */
export function WallInspector({
  wall,
  cellMM,
  ceilingMM,
  doorArmed,
  onArmDoor,
  selectedDoor = null,
  onSelectDoor,
  onPatch,
  onDelete,
}: {
  wall: FloorPlanWall
  cellMM: number
  ceilingMM: number
  doorArmed: boolean
  onArmDoor: () => void
  /** The door selected on the plan. */
  selectedDoor?: number | null
  onSelectDoor?: (index: number | null) => void
  onPatch: (body: Partial<FloorPlanWall>) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(wall.label)
  const [height, setHeight] = useState(
    wall.height_mm == null ? "" : String(wall.height_mm)
  )
  const [thickness, setThickness] = useState(
    wall.thickness_mm == null ? "" : String(wall.thickness_mm)
  )
  const openings = wall.openings
  // Total run length (m) - the number a builder actually wants at a glance.
  const runM =
    wall.points.reduce((acc, p, i) => {
      if (i === 0) return 0
      const [px, py] = wall.points[i - 1]
      return acc + Math.hypot(p[0] - px, p[1] - py)
    }, 0) *
    (cellMM / 1000)

  const patchOpening = (idx: number, patch: Partial<FloorPlanWallOpening>) => {
    const next = openings.map((o, i) => (i === idx ? { ...o, ...patch } : o))
    onPatch({ openings: next })
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Wall
      </div>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Label</span>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== wall.label && onPatch({ label })}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder="North wall"
          className="h-8"
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Height (mm)</span>
        <Input
          type="number"
          min={200}
          max={20000}
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          onBlur={() => {
            const v = height.trim() === "" ? null : Number(height)
            if (v !== null && !Number.isFinite(v)) return
            if (v !== wall.height_mm) onPatch({ height_mm: v })
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder={`${ceilingMM} (ceiling)`}
          className="h-8"
        />
        <span className="text-[10px] text-muted-foreground">
          Blank = full height (the plan's ceiling).
        </span>
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Thickness (mm)</span>
        <Input
          type="number"
          min={20}
          max={2000}
          value={thickness}
          onChange={(e) => setThickness(e.target.value)}
          onBlur={() => {
            const v = thickness.trim() === "" ? null : Number(thickness)
            if (v !== null && (!Number.isFinite(v) || v < 20 || v > 2000))
              return
            if (v !== (wall.thickness_mm ?? null)) onPatch({ thickness_mm: v })
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder={String(WALL_DEFAULT_MM)}
          className="h-8"
        />
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Color</span>
        <ColorPicker
          value={wall.color}
          onChange={(color) => onPatch({ color })}
        />
      </div>

      <div className="grid gap-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Doors</span>
          <Button
            size="sm"
            variant={doorArmed ? "default" : "outline"}
            className="h-6 px-2"
            onClick={onArmDoor}
          >
            {doorArmed ? "Drag along the wall…" : "Add door"}
          </Button>
        </div>
        {openings.length === 0 && !doorArmed && (
          <p className="text-[11px] text-muted-foreground">
            No doors yet.
          </p>
        )}
        {openings.map((o, i) => {
          const widthMM = Math.round((o.to - o.from) * cellMM)
          return (
            <div
              key={i}
              data-door-card={i}
              className={cn(
                "grid gap-1.5 rounded-md border border-border p-2",
                selectedDoor === i && "ring-1 ring-primary"
              )}
              onClick={() => onSelectDoor?.(i)}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  Door {i + 1}
                  <span className="num ml-1 text-[10px] text-muted-foreground">
                    seg {o.seg + 1}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                  aria-label="Remove door"
                  onClick={() =>
                    onPatch({ openings: openings.filter((_, x) => x !== i) })
                  }
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <label className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Width (mm)
                  </span>
                  <Input
                    key={`${o.from}-${o.to}`}
                    type="number"
                    min={100}
                    defaultValue={widthMM}
                    onBlur={(e) => {
                      const v = Number(e.target.value)
                      if (!Number.isFinite(v) || v < 100 || v === widthMM)
                        return
                      // Grow/shrink about the door's centre, in cells.
                      const c = (o.from + o.to) / 2
                      const half = v / cellMM / 2
                      patchOpening(i, {
                        from: Math.max(0, Math.round((c - half) * 100) / 100),
                        to: Math.round((c + half) * 100) / 100,
                      })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                    }}
                    className="h-7"
                  />
                </label>
                <label className="grid gap-0.5">
                  <span className="text-[10px] text-muted-foreground">
                    Height (mm)
                  </span>
                  <Input
                    type="number"
                    min={200}
                    defaultValue={o.height_mm ?? ""}
                    placeholder="2100"
                    onBlur={(e) => {
                      const raw = e.target.value.trim()
                      const v = raw === "" ? null : Number(raw)
                      if (v !== null && !Number.isFinite(v)) return
                      if (v !== o.height_mm) patchOpening(i, { height_mm: v })
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                    }}
                    className="h-7"
                  />
                </label>
              </div>
              <label className="grid gap-0.5">
                <span className="text-[10px] text-muted-foreground">Swing</span>
                <Select
                  value={o.hinge && o.side ? `${o.hinge}-${o.side}` : "none"}
                  onValueChange={(v) => {
                    if (v === "none") {
                      const { hinge: _h, side: _s, ...rest } = o
                      onPatch({
                        openings: openings.map((x, k) => (k === i ? rest : x)),
                      })
                      return
                    }
                    const [hinge, side] = v.split("-") as [
                      "start" | "end",
                      "left" | "right",
                    ]
                    patchOpening(i, { hinge, side })
                  }}
                >
                  <SelectTrigger size="sm" className="h-7 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Opening</SelectItem>
                    <SelectItem value="start-left">Start, left</SelectItem>
                    <SelectItem value="start-right">Start, right</SelectItem>
                    <SelectItem value="end-left">End, left</SelectItem>
                    <SelectItem value="end-right">End, right</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
          )
        })}
      </div>

      <div className="num text-[11px] text-muted-foreground">
        {Math.max(0, wall.points.length - 1)} segment
        {wall.points.length - 1 === 1 ? "" : "s"} ·{" "}
        {runM.toFixed(1).replace(/\.0$/, "")} m run
      </div>
      <div className="mt-auto">
        <Button
          size="sm"
          variant="ghost"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete wall
        </Button>
      </div>
    </aside>
  )
}

/** Structure-mode right panel: edit the selected raised-floor area. */
export function AreaInspector({
  area,
  onPatch,
  onDelete,
}: {
  area: RaisedFloorArea
  onPatch: (body: Partial<RaisedFloorArea>) => void
  onDelete: () => void
}) {
  const [label, setLabel] = useState(area.label)
  const [plenum, setPlenum] = useState(String(area.plenum_mm))
  return (
    <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border p-3">
      <div className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        Raised floor
      </div>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Label</span>
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onBlur={() => label !== area.label && onPatch({ label })}
          onKeyDown={(e) => {
            // Enter = commit, the key everyone presses in a text field.
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          placeholder="DC pad"
          className="h-8"
        />
      </label>
      <label className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Plenum depth (mm)</span>
        <Input
          type="number"
          min={50}
          max={2000}
          value={plenum}
          onChange={(e) => setPlenum(e.target.value)}
          onBlur={() => {
            const v = Number(plenum)
            if (Number.isFinite(v) && v !== area.plenum_mm)
              onPatch({ plenum_mm: v })
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
          }}
          className="h-8"
        />
        <span className="text-[10px] text-muted-foreground">
          Underfloor trays and cable-length drops in this area use this depth.
        </span>
      </label>
      <div className="grid gap-1 text-xs">
        <span className="text-muted-foreground">Color</span>
        <ColorPicker
          value={area.color}
          onChange={(color) => onPatch({ color })}
        />
      </div>
      <div className="num text-[11px] text-muted-foreground">
        {area.width}×{area.height} cells at ({area.x}, {area.y})
      </div>
      <div className="mt-auto">
        <Button
          size="sm"
          variant="ghost"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete area
        </Button>
      </div>
    </aside>
  )
}
