import { Spline, Trash2, X } from "lucide-react"
import { useState } from "react"

import type {
  FloorPlanTray,
  FloorPlanTrayWritePayload,
  TrayLevel,
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
import { CableAdd } from "@/components/cable-add"
import { Field } from "@/components/forms"
import { BarTip } from "@/components/map-toolbar"
import { RowDelete } from "./structure-panels"
import { cn } from "@/lib/utils"

/** Cables-mode left rail - draw control, edit toggle + the tray list. */
export function TrayRail({
  trays,
  selectedTrayId,
  drawing,
  editMode,
  onToggleEdit,
  onSelectTray,
  onStartDraw,
  onCancelDraw,
  onDeleteTray,
}: {
  /** A row's delete. */
  onDeleteTray?: (id: string) => void
  trays: FloorPlanTray[]
  selectedTrayId: string | null
  drawing: boolean
  editMode: boolean
  onToggleEdit: () => void
  onSelectTray: (id: string | null) => void
  onStartDraw: () => void
  onCancelDraw: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cable trays
        </span>
        {drawing ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-destructive hover:text-destructive"
            onClick={onCancelDraw}
          >
            Cancel
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5"
            onClick={onStartDraw}
          >
            <Spline className="h-3.5 w-3.5" /> Draw
          </Button>
        )}
      </div>
      {!drawing && (
        <div className="px-2 pb-2">
          <Button
            variant={editMode ? "default" : "outline"}
            size="sm"
            className="w-full gap-1.5"
            onClick={onToggleEdit}
          >
            <Spline className="h-3.5 w-3.5" />
            {editMode ? "Done editing trays" : "Edit trays"}
          </Button>
          {editMode && (
            <p className="px-1 pt-1.5 text-[11px] text-muted-foreground">
              Cables hidden. Click a tray to reshape - drag points, ＋ to add a
              bend, right-click a point to remove.
            </p>
          )}
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-0">
        {trays.length === 0 && !drawing && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No trays yet. Click <span className="font-medium">Draw</span>, then
            click grid corners to route a tray a builder can follow. Assign the
            physical cables to it once it's drawn.
          </p>
        )}
        {trays.map((tray) => (
          <div
            key={tray.id}
            className={cn(
              "flex items-center rounded-md pr-1 hover:bg-muted/60",
              tray.id === selectedTrayId && "bg-muted ring-1 ring-foreground/20"
            )}
          >
            <button
              type="button"
              onClick={() => onSelectTray(tray.id)}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
            >
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: tray.color || "#71717a" }}
              />
              <span className="truncate">{tray.name}</span>
              <span className="num ml-auto text-[10px] text-muted-foreground">
                {tray.cables.length}
              </span>
            </button>
            {onDeleteTray && (
              <RowDelete
                label={`Delete ${tray.name || "tray"}`}
                onClick={() => onDeleteTray(tray.id)}
              />
            )}
          </div>
        ))}
      </div>
    </aside>
  )
}

/** Cables-mode right inspector - tray details + cable assignment. */
export function TrayInspector({
  tray,
  highlightCableId,
  editing,
  onEditShape,
  onHighlightCable,
  onPatch,
  onDelete,
  saved = true,
}: {
  tray: FloorPlanTray
  /** On the server: a new tray takes cables once the plan is saved. */
  saved?: boolean
  highlightCableId: string | null
  editing: boolean
  onEditShape: () => void
  onHighlightCable: (cableId: string | null) => void
  onPatch: (patch: FloorPlanTrayWritePayload) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(tray.name)
  const [kind, setKind] = useState(tray.kind)
  const [elevation, setElevation] = useState(
    tray.elevation_mm != null ? String(tray.elevation_mm) : ""
  )

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Tray
        </span>
        <span className="num text-[11px] text-muted-foreground">
          {tray.points.length} points
        </span>
      </div>

      <Button
        variant={editing ? "default" : "outline"}
        size="sm"
        className="w-full"
        onClick={onEditShape}
      >
        <Spline className="h-3.5 w-3.5" />
        {editing ? "Done editing shape" : "Edit shape"}
      </Button>

      <Field label="Name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== tray.name && onPatch({ name })}
          className="h-8 text-sm"
        />
      </Field>
      <Field label="Kind" hint="tray, conduit, ladder…">
        <Input
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          onBlur={() => kind !== tray.kind && onPatch({ kind })}
          placeholder="Optional"
          className="h-8 text-sm"
        />
      </Field>
      <Field label="Color">
        <ColorPicker
          value={tray.color}
          onChange={(color) => onPatch({ color })}
        />
      </Field>
      <Field label="Level" hint="Where the run physically lives">
        <Select
          value={tray.level}
          onValueChange={(v) => onPatch({ level: v as TrayLevel })}
        >
          <SelectTrigger size="sm" className="h-8 w-full text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="overhead">Overhead</SelectItem>
            <SelectItem value="underfloor">Underfloor</SelectItem>
            <SelectItem value="floor">Floor level</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Elevation (mm)"
        hint="Height above floor - blank derives from the level"
      >
        <Input
          type="number"
          value={elevation}
          onChange={(e) => setElevation(e.target.value)}
          onBlur={() => {
            const v = elevation.trim() === "" ? null : Number(elevation)
            if (v !== tray.elevation_mm) onPatch({ elevation_mm: v })
          }}
          placeholder="Auto"
          className="h-8 text-sm"
        />
      </Field>

      <div className="grid gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cables in this tray
        </span>
        {tray.cables.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {saved ? "None assigned yet." : "Save the plan to add cables."}
          </p>
        )}
        <ul className="grid gap-1">
          {tray.cables.map((c) => (
            <li
              key={c.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[13px]",
                highlightCableId === c.id && "ring-1 ring-primary"
              )}
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                onClick={() =>
                  onHighlightCable(highlightCableId === c.id ? null : c.id)
                }
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color || "#0ea5e9" }}
                />
                <span className="truncate font-mono text-xs">{c.label}</span>
                {c.type && (
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {c.type}
                  </span>
                )}
              </button>
              <BarTip tip="Remove">
                <button
                  type="button"
                  aria-label={`Remove ${c.label}`}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onPatch({
                      cable_ids: tray.cables
                        .filter((x) => x.id !== c.id)
                        .map((x) => x.id),
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </BarTip>
            </li>
          ))}
        </ul>
        {saved && (
          <CableAdd
            excludeIds={tray.cables.map((c) => c.id)}
            onAdd={(cableId) =>
              onPatch({ cable_ids: [...tray.cables.map((c) => c.id), cableId] })
            }
          />
        )}
      </div>

      <div className="mt-auto border-t border-border pt-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete tray
        </Button>
      </div>
    </aside>
  )
}
