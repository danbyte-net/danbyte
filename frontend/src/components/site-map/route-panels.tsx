import { useEffect, useState } from "react"
import { Spline, Trash2, X } from "lucide-react"

import type { CableRoute, CableRouteWritePayload } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorPicker } from "@/components/ui/color-picker"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { CableAdd } from "@/components/cable-add"
import { Field } from "@/components/forms"
import { cn } from "@/lib/utils"

// Cables-mode panels for the site map — straight clones of the floor
// planner's TrayRail / TrayInspector / TrayNameDialog, with routes
// (geographic duct/aerial runs) in place of trays.

/** Cables-mode left rail — draw control, edit toggle + the route list. */
export function RouteRail({
  routes,
  selectedRouteId,
  drawing,
  editMode,
  onToggleEdit,
  onSelectRoute,
  onStartDraw,
  onCancelDraw,
}: {
  routes: CableRoute[]
  selectedRouteId: string | null
  drawing: boolean
  editMode: boolean
  onToggleEdit: () => void
  onSelectRoute: (id: string | null) => void
  onStartDraw: () => void
  onCancelDraw: () => void
}) {
  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cable routes
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
            {editMode ? "Done editing routes" : "Edit routes"}
          </Button>
          {editMode && (
            <p className="px-1 pt-1.5 text-[11px] text-muted-foreground">
              Click a route to reshape — drag points, ＋ to add a bend,
              right-click a point to remove.
            </p>
          )}
        </div>
      )}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-2 pt-0">
        {routes.length === 0 && !drawing && (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            No routes yet. Click <span className="font-medium">Draw</span>, then
            click the map along the duct / aerial / trench path your fiber
            actually follows. Assign the physical cables once it's drawn.
          </p>
        )}
        {routes.map((r) => (
          <button
            key={r.id}
            type="button"
            onClick={() => onSelectRoute(r.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted/60",
              r.id === selectedRouteId && "bg-muted ring-1 ring-foreground/20"
            )}
          >
            <span
              className="h-3 w-3 shrink-0 rounded-full"
              style={{ backgroundColor: r.color || "#71717a" }}
            />
            <span className="truncate">{r.name}</span>
            <span className="num ml-auto text-[10px] text-muted-foreground">
              {r.cables.length}
            </span>
          </button>
        ))}
      </div>
    </aside>
  )
}

/** Cables-mode right inspector — route details + cable assignment. */
export function RouteInspector({
  route,
  highlightCableId,
  editing,
  canEdit,
  onEditShape,
  onHighlightCable,
  onPatch,
  onDelete,
  onClose,
}: {
  route: CableRoute
  highlightCableId: string | null
  editing: boolean
  canEdit: boolean
  onEditShape: () => void
  onHighlightCable: (cableId: string | null) => void
  onPatch: (patch: CableRouteWritePayload) => void
  onDelete: () => void
  onClose: () => void
}) {
  const [name, setName] = useState(route.name)
  const [kind, setKind] = useState(route.kind)
  useEffect(() => {
    setName(route.name)
    setKind(route.kind)
  }, [route.id, route.name, route.kind])

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Route
        </span>
        <span className="flex items-center gap-2">
          <span className="num text-[11px] text-muted-foreground">
            {route.waypoints.length} points
          </span>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close inspector"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>

      {canEdit && (
        <Button
          variant={editing ? "default" : "outline"}
          size="sm"
          className="w-full"
          onClick={onEditShape}
        >
          <Spline className="h-3.5 w-3.5" />
          {editing ? "Done editing shape" : "Edit shape (add bends, move)"}
        </Button>
      )}

      {canEdit ? (
        <>
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() =>
                name.trim() && name !== route.name && onPatch({ name })
              }
              className="h-8 text-sm"
            />
          </Field>
          <Field label="Kind" hint="duct, aerial, direct-bury…">
            <Input
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              onBlur={() => kind !== route.kind && onPatch({ kind })}
              placeholder="Optional"
              className="h-8 text-sm"
            />
          </Field>
          <Field label="Color">
            <ColorPicker
              value={route.color}
              onChange={(color) => onPatch({ color })}
            />
          </Field>
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ backgroundColor: route.color || "#71717a" }}
          />
          <span className="min-w-0 truncate font-medium">{route.name}</span>
          {route.kind && (
            <span className="ml-auto text-[11px] text-muted-foreground">
              {route.kind}
            </span>
          )}
        </div>
      )}

      <div className="grid gap-2">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Cables on this route
        </span>
        {route.cables.length === 0 && (
          <p className="text-xs text-muted-foreground">None assigned yet.</p>
        )}
        <ul className="grid gap-1">
          {route.cables.map((c) => (
            <li
              key={c.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[13px]",
                highlightCableId === c.id && "ring-1 ring-primary"
              )}
            >
              <button
                type="button"
                title="Highlight this cable's run"
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
              {canEdit && (
                <button
                  type="button"
                  title="Remove"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() =>
                    onPatch({
                      cable_ids: route.cables
                        .filter((x) => x.id !== c.id)
                        .map((x) => x.id),
                    })
                  }
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
        {canEdit && (
          <CableAdd
            excludeIds={route.cables.map((c) => c.id)}
            onAdd={(cableId) =>
              onPatch({
                cable_ids: [...route.cables.map((c) => c.id), cableId],
              })
            }
          />
        )}
      </div>

      {canEdit && (
        <div className="mt-auto border-t border-border pt-3">
          <Button
            variant="outline"
            size="sm"
            className="w-full text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete route
          </Button>
        </div>
      )}
    </aside>
  )
}

/** Name a freshly-drawn route, then create it. */
export function RouteNameDialog({
  waypoints,
  onCancel,
  onCreate,
}: {
  waypoints: [number, number][] | null
  onCancel: () => void
  onCreate: (payload: CableRouteWritePayload) => void
}) {
  const [name, setName] = useState("")
  const [kind, setKind] = useState("")
  const [color, setColor] = useState("#71717a")
  // Cables assigned right at draw time — drawing a single cable's path
  // without any duct ceremony: pick the cable, the name prefills from it.
  const [cables, setCables] = useState<
    { id: string; label: string; color: string }[]
  >([])

  useEffect(() => {
    if (waypoints) {
      setName("")
      setKind("")
      setColor("#71717a")
      setCables([])
    }
  }, [waypoints])

  return (
    <Dialog open={waypoints !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Name this route</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || !waypoints) return
            onCreate({
              name: name.trim(),
              kind,
              color,
              waypoints,
              ...(cables.length ? { cable_ids: cables.map((c) => c.id) } : {}),
            })
          }}
        >
          <Field label="Name" hint="What the plant records call it">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Duct A · Main street"
              className="h-9"
            />
          </Field>
          <Field label="Kind" hint="duct, aerial, direct-bury…">
            <Input
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="Optional"
              className="h-9"
            />
          </Field>
          <Field label="Color">
            <ColorPicker value={color} onChange={setColor} allowEmpty={false} />
          </Field>
          <Field
            label="Cables"
            hint="Optional — a run doesn't have to be a duct; pick one cable and the line you drew IS that cable's path"
          >
            <div className="grid gap-1.5">
              {cables.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-[13px]"
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: c.color || "#0ea5e9" }}
                  />
                  <span className="truncate font-mono text-xs">{c.label}</span>
                  <button
                    type="button"
                    className="ml-auto text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${c.label}`}
                    onClick={() =>
                      setCables((prev) => prev.filter((x) => x.id !== c.id))
                    }
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <CableAdd
                excludeIds={cables.map((c) => c.id)}
                onAdd={(id, cable) => {
                  const label = cable.label || `Cable #${cable.numid}`
                  setCables((prev) => [
                    ...prev,
                    { id, label, color: cable.color },
                  ])
                  if (!name.trim()) setName(label)
                  if (cable.color) setColor(cable.color)
                }}
              />
            </div>
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Create route
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
