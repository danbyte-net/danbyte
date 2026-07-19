import { useEffect, useMemo, useState } from "react"
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DeviceType,
  type DeviceTypeWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  CONNECTOR_MM,
  PANEL_MM,
  familyForType,
  renderTemplateName,
} from "@/lib/faceplate-geometry"
import {
  autoLayout,
  portNumber,
  type FaceplateDoc,
  type FaceplateGroup,
  type FaceplateSide,
  type FaceplateSlot,
  type PortComponent,
  type SlotKind,
} from "@/lib/faceplate-layout"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  TEMPLATE_ENDPOINT,
  TEMPLATE_QUERY_KEY,
  type TemplateKind,
} from "@/components/component-template-dialog"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

// The eight PLACEABLE kinds (SlotKind ⊂ TemplateKind — module bays are
// templates but not faceplate slots in M1).
const KINDS: SlotKind[] = [
  "interface",
  "console-port",
  "console-server-port",
  "power-port",
  "power-outlet",
  "front-port",
  "rear-port",
  "aux-port",
]

const KIND_TITLE: Record<TemplateKind, string> = {
  "module-bay": "Module bays", // not placeable on faceplates (M1)
  "device-bay": "Device bays", // not placeable on faceplates
  "inventory-item": "Inventory", // not placeable on faceplates
  interface: "Interfaces",
  "console-port": "Console ports",
  "console-server-port": "Console server ports",
  "power-port": "Power ports",
  "power-outlet": "Power outlets",
  "front-port": "Front ports",
  "rear-port": "Rear ports",
  "aux-port": "Aux ports",
}

// Builder scale — larger than the read-only renderer so cages are easy to
// grab (an SFP cage lands at ~31×21px).
const BUILDER_SCALE = 2.2

// Common bank sizes; anything else goes through the Custom… input.
const BANK_PRESETS = [0, 4, 6, 8, 12]

// Drag-id separator — a control char that can never appear in a template name.
const SEP = "\u001f"

const slotKey = (s: FaceplateSlot, gi: number, si: number) =>
  s.t === "port"
    ? `port:${s.kind ?? "interface"}:${s.name}`
    : `${s.t}:${gi}:${si}`

let groupSeq = 0
const newGroupId = () => `g${Date.now().toString(36)}-${groupSeq++}`

/**
 * Drag-and-drop faceplate builder. The canvas IS the true-scale panel — the
 * same visual as the device page's front panel, with every cage draggable.
 * Click a group to edit its label / rows / banking in the toolbar. Front and
 * rear are separate sides of one saved doc. Explicit Save only.
 */
/** What the builder needs from its owner — a DeviceType, or a ModuleType
 * dressed up as one (modules are 1U, full-width panels). */
export interface FaceplateHost {
  id: string
  faceplate: FaceplateDoc | null
  u_height: number
  rack_width: "full" | "half"
}

export function DeviceTypeFaceplatePane({
  deviceType,
  moduleMode = false,
}: {
  deviceType: FaceplateHost
  /** Module-type owner: interface palette only, saves to /api/module-types/. */
  moduleMode?: boolean
}) {
  const { canDo } = useMe()
  const canWrite = canDo(moduleMode ? "moduletype" : "devicetype", "change")
  const qc = useQueryClient()
  const kinds: SlotKind[] = moduleMode ? ["interface"] : KINDS

  // All template lists — same query keys as the Components tab (module
  // types have a single interface-template list).
  const templateQueries = useQueries({
    queries: kinds.map((k) => ({
      queryKey: moduleMode
        ? ["mt-interface-templates", deviceType.id]
        : [TEMPLATE_QUERY_KEY[k], deviceType.id],
      queryFn: () =>
        api<Paginated<PortComponent>>(
          moduleMode
            ? `/api/module-interface-templates/?module_type=${deviceType.id}`
            : `/api/${TEMPLATE_ENDPOINT[k]}/?device_type=${deviceType.id}`
        ),
    })),
  })
  const templatesByKind = useMemo(() => {
    const out: Partial<Record<SlotKind, PortComponent[]>> = {}
    kinds.forEach((k, i) => {
      out[k] = templateQueries[i]?.data?.results ?? []
    })
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...templateQueries.map((q) => q.data)])
  const templatesLoaded = templateQueries.every((q) => !q.isLoading)

  const seed = useMemo<FaceplateDoc>(
    () => deviceType.faceplate ?? autoLayout(templatesByKind.interface ?? []),
    [deviceType.faceplate, templatesByKind.interface]
  )
  const [draft, setDraft] = useState<FaceplateDoc>(seed)
  const [dirty, setDirty] = useState(false)
  const [side, setSide] = useState<FaceplateSide>("front")
  const [selectedGroup, setSelectedGroup] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [dragCage, setDragCage] = useState<{
    family: ReturnType<typeof familyForType>
    num: number | null
  } | null>(null)

  useEffect(() => {
    if (!dirty) setDraft(seed)
  }, [seed, dirty])

  const update = (next: FaceplateDoc) => {
    setDraft(next)
    setDirty(true)
  }

  // Fast lookup: (kind, lowercase rendered name) → template. Position tokens
  // render with their standalone defaults, mirroring materialisation.
  const templateIndex = useMemo(() => {
    const map = new Map<string, PortComponent>()
    for (const k of kinds)
      for (const t of templatesByKind[k] ?? [])
        map.set(`${k}:${t.name.toLowerCase()}`, t)
    return map
  }, [templatesByKind])

  // Ports already placed on EITHER side — a port is front or rear, not both.
  const placed = useMemo(() => {
    const set = new Set<string>()
    for (const s of ["front", "rear"] as const)
      for (const g of draft[s] ?? [])
        for (const slot of g.slots)
          if (slot.t === "port")
            set.add(`${slot.kind ?? "interface"}:${slot.name.toLowerCase()}`)
    return set
  }, [draft])

  const unplaced = useMemo(
    () =>
      kinds
        .map((k) => ({
          kind: k,
          items: (templatesByKind[k] ?? []).filter(
            (t) => !placed.has(`${k}:${t.name.toLowerCase()}`)
          ),
        }))
        .filter((s) => s.items.length > 0),
    [templatesByKind, placed]
  )

  const ghosts = useMemo(() => {
    let n = 0
    for (const s of ["front", "rear"] as const)
      for (const g of draft[s] ?? [])
        for (const slot of g.slots)
          if (
            slot.t === "port" &&
            !templateIndex.has(
              `${slot.kind ?? "interface"}:${slot.name.toLowerCase()}`
            )
          )
            n++
    return n
  }, [draft, templateIndex])

  const save = useMutation({
    mutationFn: (doc: FaceplateDoc | null) =>
      api<DeviceType>(
        moduleMode
          ? `/api/module-types/${deviceType.id}/`
          : `/api/device-types/${deviceType.id}/`,
        {
          method: "PATCH",
          body: JSON.stringify({ faceplate: doc } as DeviceTypeWritePayload),
        }
      ),
    onSuccess: (_saved, doc) => {
      qc.invalidateQueries({
        queryKey: [moduleMode ? "module-type" : "device-type", deviceType.id],
      })
      qc.invalidateQueries({
        queryKey: [moduleMode ? "module-types" : "device-types"],
      })
      setDirty(false)
      if (doc === null) {
        setDraft(autoLayout(templatesByKind.interface ?? []))
        toast.success("Faceplate reset to automatic layout")
      } else {
        toast.success("Faceplate saved")
      }
    },
    onError: (err) => apiErrorToast(err),
  })

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } })
  )

  // ── draft helpers (all operate on the ACTIVE side) ────────────────────────

  const sideGroups = draft[side]
  const withSide = (groups: FaceplateGroup[]): FaceplateDoc => ({
    ...draft,
    [side]: groups.filter((g) => g.slots.length > 0 || g.id === selectedGroup),
  })

  function findSlot(id: string): { gi: number; si: number } | null {
    const [, gid, key] = id.split(SEP)
    const gi = sideGroups.findIndex((g) => g.id === gid)
    if (gi === -1) return null
    const si = sideGroups[gi].slots.findIndex(
      (s, i) => slotKey(s, gi, i) === key
    )
    return si === -1 ? null : { gi, si }
  }

  function onDragStart(e: DragStartEvent) {
    const id = String(e.active.id)
    const parts = id.split(SEP)
    // Resolve the dragged thing to a cage (family + number) so the overlay is
    // a small mm-true box under the cursor — a long name there hides the
    // drop target.
    if (parts[0] === "pal") {
      const [, kind, name] = parts
      const tpl = templateIndex.get(`${kind}:${name.toLowerCase()}`)
      const rendered = renderTemplateName(name, null)
      setDragCage({
        family: familyForType(tpl?.type ?? ""),
        num: portNumber(rendered),
      })
      return
    }
    const from = findSlot(id)
    const slot = from ? sideGroups[from.gi].slots[from.si] : null
    if (!slot || slot.t === "label") {
      setDragCage({ family: "generic", num: null })
      return
    }
    if (slot.t === "blank") {
      setDragCage({ family: slot.family ?? "generic", num: null })
      return
    }
    const tpl = templateIndex.get(
      `${slot.kind ?? "interface"}:${slot.name.toLowerCase()}`
    )
    setDragCage({
      family: familyForType(tpl?.type ?? ""),
      num: portNumber(renderTemplateName(slot.name, null)),
    })
  }

  function onDragEnd(e: DragEndEvent) {
    setDragCage(null)
    const { active, over } = e
    if (!over) return
    const a = String(active.id)
    const o = String(over.id)
    const groups = sideGroups.map((g) => ({ ...g, slots: [...g.slots] }))

    let slot: FaceplateSlot | null = null
    if (a.startsWith(`pal${SEP}`)) {
      const [, kind, name] = a.split(SEP)
      slot = { t: "port", kind: kind as SlotKind, name }
    } else {
      const from = findSlot(a)
      if (!from) return
      slot = groups[from.gi].slots[from.si]
      if (o.startsWith(`slot${SEP}`)) {
        const to = findSlot(o)
        if (to && to.gi === from.gi) {
          groups[from.gi].slots = arrayMove(
            groups[from.gi].slots,
            from.si,
            to.si
          )
          update(withSide(groups))
          return
        }
      }
      groups[from.gi].slots.splice(from.si, 1)
    }
    if (!slot) return

    if (o.startsWith("newgroup:")) {
      const lane = Math.max(1, Number(o.slice("newgroup:".length)) || 1)
      const id = newGroupId()
      groups.push({ id, rows: 1, bank: 0, u: lane, slots: [slot] })
      setSelectedGroup(id)
    } else if (o.startsWith(`group${SEP}`)) {
      const gid = o.slice(`group${SEP}`.length)
      const g = groups.find((x) => x.id === gid)
      if (!g) return
      g.slots.push(slot)
    } else if (o.startsWith(`slot${SEP}`)) {
      const to = findSlot(o)
      if (!to) return
      groups[to.gi].slots.splice(to.si, 0, slot)
    } else {
      return
    }
    update(withSide(groups.filter((g) => g.slots.length > 0)))
  }

  const patchGroup = (gid: string, patch: Partial<FaceplateGroup>) =>
    update({
      ...draft,
      [side]: sideGroups.map((g) => (g.id === gid ? { ...g, ...patch } : g)),
    })

  const removeSlot = (gid: string, index: number) =>
    update(
      withSide(
        sideGroups
          .map((g) =>
            g.id === gid
              ? { ...g, slots: g.slots.filter((_, i) => i !== index) }
              : g
          )
          .filter((g) => g.slots.length > 0)
      )
    )

  const selected = sideGroups.find((g) => g.id === selectedGroup) ?? null

  if (!templatesLoaded)
    return <p className="text-sm text-muted-foreground">Loading templates…</p>

  const hasTemplates = kinds.some((k) => (templatesByKind[k] ?? []).length > 0)
  if (!hasTemplates)
    return (
      <p className="max-w-2xl text-sm text-muted-foreground">
        This device type has no component templates yet — add interfaces (and
        console / power / aux ports) on the Components tab first, then lay them
        out here.
      </p>
    )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedTabs
          value={side}
          onValueChange={(v) => {
            setSide(v)
            setSelectedGroup(null)
          }}
          items={[
            {
              value: "front",
              label: "Front",
              count: draft.front.length || null,
            },
            { value: "rear", label: "Rear", count: draft.rear.length || null },
          ]}
        />
        <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <input
            type="checkbox"
            className="ck"
            checked={!!draft.full}
            disabled={!canWrite}
            onChange={(e) =>
              update({ ...draft, full: e.target.checked || undefined })
            }
          />
          Full width
        </label>
        <p className="text-[12px] text-muted-foreground">
          Drag ports from the palette onto the panel — it draws at true scale,
          exactly as devices of this type will render. Click a group to edit it.
        </p>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        <div className="grid gap-4 xl:grid-cols-[240px_1fr]">
          {/* Palette */}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Unplaced templates
            </h3>
            {unplaced.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                Everything is placed.
              </p>
            ) : (
              unplaced.map((sec) => (
                <details key={sec.kind} open className="space-y-1">
                  <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
                    {KIND_TITLE[sec.kind]}{" "}
                    <span className="num">({sec.items.length})</span>
                  </summary>
                  <div className="flex flex-wrap gap-1 pt-1">
                    {sec.items.map((t) => (
                      <PaletteCage
                        key={t.id}
                        kind={sec.kind}
                        template={t}
                        disabled={!canWrite}
                      />
                    ))}
                  </div>
                </details>
              ))
            )}
          </div>

          {/* Canvas — the panel itself */}
          <div className="min-w-0 space-y-3">
            {/* Group toolbar (edits the selected group) */}
            <div className="flex h-9 flex-wrap items-center gap-2">
              {selected ? (
                <>
                  <Input
                    value={selected.label ?? ""}
                    onChange={(e) =>
                      patchGroup(selected.id, {
                        label: e.target.value || undefined,
                      })
                    }
                    placeholder="Group label"
                    disabled={!canWrite}
                    className="h-7 w-44 font-mono text-[12px]"
                  />
                  <Select
                    value={String(selected.rows)}
                    onValueChange={(v) =>
                      patchGroup(selected.id, {
                        rows: Number(v) as 1 | 2 | 3 | 4,
                      })
                    }
                    disabled={!canWrite}
                  >
                    <SelectTrigger size="sm" className="h-7 w-24 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1 row</SelectItem>
                      <SelectItem value="2">2 rows</SelectItem>
                      <SelectItem value="3">3 rows</SelectItem>
                      <SelectItem value="4">4 rows</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={
                      BANK_PRESETS.includes(selected.bank)
                        ? String(selected.bank)
                        : "custom"
                    }
                    onValueChange={(v) => {
                      if (v === "custom") {
                        // Nudge to a non-preset value so the input appears;
                        // the user types the real size next door.
                        if (BANK_PRESETS.includes(selected.bank))
                          patchGroup(selected.id, { bank: 10 })
                        return
                      }
                      patchGroup(selected.id, { bank: Number(v) })
                    }}
                    disabled={!canWrite}
                  >
                    <SelectTrigger size="sm" className="h-7 w-28 text-[12px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BANK_PRESETS.map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          {n === 0 ? "No banks" : `Banks of ${n}`}
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">Custom…</SelectItem>
                    </SelectContent>
                  </Select>
                  {!BANK_PRESETS.includes(selected.bank) && (
                    <Input
                      type="number"
                      min={0}
                      max={48}
                      value={selected.bank}
                      disabled={!canWrite}
                      onChange={(e) => {
                        const n = Math.max(
                          0,
                          Math.min(48, Number(e.target.value) || 0)
                        )
                        patchGroup(selected.id, { bank: n })
                      }}
                      className="num h-7 w-16 text-[12px]"
                      aria-label="Custom bank size"
                    />
                  )}
                  {deviceType.u_height > 1 && (
                    <Select
                      value={String(selected.u ?? 1)}
                      onValueChange={(v) =>
                        patchGroup(selected.id, { u: Number(v) })
                      }
                      disabled={!canWrite}
                    >
                      <SelectTrigger size="sm" className="h-7 w-20 text-[12px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Array.from(
                          { length: deviceType.u_height },
                          (_, i) => i + 1
                        ).map((u) => (
                          <SelectItem key={u} value={String(u)}>
                            U{u}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  {canWrite && (
                    <>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() =>
                          patchGroup(selected.id, {
                            slots: [...selected.slots, { t: "blank" }],
                          })
                        }
                      >
                        <Plus className="h-3 w-3" /> Blank
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          const text = window.prompt("Label text")?.trim()
                          if (text)
                            patchGroup(selected.id, {
                              slots: [...selected.slots, { t: "label", text }],
                            })
                        }}
                      >
                        <Plus className="h-3 w-3" /> Label
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        className="text-destructive hover:text-destructive"
                        aria-label="Delete group"
                        onClick={() => {
                          update({
                            ...draft,
                            [side]: sideGroups.filter(
                              (x) => x.id !== selected.id
                            ),
                          })
                          setSelectedGroup(null)
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  Click a group on the panel to edit its label, rows, and
                  banking.
                </span>
              )}
            </div>

            {/* The panel strip — one lane per rack unit (each with its own
                "+" zone), width the whole blade when the full-width tick is
                on. */}
            <div
              className="flex w-fit max-w-full flex-col overflow-x-auto rounded-md border border-border bg-muted/30 px-3"
              style={{
                rowGap: 4,
                minWidth: draft.full
                  ? Math.round(
                      PANEL_MM.opening *
                        (deviceType.rack_width === "half" ? 0.5 : 1) *
                        BUILDER_SCALE
                    )
                  : undefined,
                paddingTop: 6,
                paddingBottom: 6,
              }}
            >
              {Array.from(
                { length: Math.max(1, deviceType.u_height) },
                (_, i) => i + 1
              ).map((lane) => {
                const laneGroups = sideGroups.filter((g) => (g.u ?? 1) === lane)
                return (
                  <div
                    key={lane}
                    className="flex items-center border-b border-border/40 last:border-b-0"
                    style={{
                      columnGap: Math.round(PANEL_MM.groupGap * BUILDER_SCALE),
                      minHeight: Math.round(PANEL_MM.face * BUILDER_SCALE),
                    }}
                  >
                    {deviceType.u_height > 1 && (
                      <span className="num w-5 shrink-0 text-right font-mono text-[9px] text-muted-foreground/60">
                        U{lane}
                      </span>
                    )}
                    {laneGroups.map((g) => {
                      const gi = sideGroups.indexOf(g)
                      return (
                        <BuilderGroup
                          key={g.id}
                          group={g}
                          gi={gi}
                          selected={g.id === selectedGroup}
                          onSelect={() => setSelectedGroup(g.id)}
                          canWrite={canWrite}
                          templateIndex={templateIndex}
                          onRemoveSlot={(i) => removeSlot(g.id, i)}
                        />
                      )
                    })}
                    <NewGroupZone
                      lane={lane}
                      onClick={() => {
                        if (!canWrite) return
                        const id = newGroupId()
                        update({
                          ...draft,
                          [side]: [
                            ...sideGroups,
                            { id, rows: 1, bank: 0, u: lane, slots: [] },
                          ],
                        })
                        setSelectedGroup(id)
                      }}
                    />
                  </div>
                )
              })}
            </div>

            <p className="text-[11px] text-muted-foreground">
              Tip: double-click a cage to remove it (back to the palette).
            </p>
          </div>
        </div>
        {/* The overlay is a cage-sized box (just the port number) so the drop
            target stays visible under the cursor. */}
        <DragOverlay dropAnimation={null}>
          {dragCage && (
            <span
              style={cageStyle(dragCage.family)}
              className="num flex cursor-grabbing items-center justify-center rounded-[3px] border border-primary bg-background text-[9px] leading-none font-medium text-foreground shadow-sm"
            >
              {dragCage.num ?? ""}
            </span>
          )}
        </DragOverlay>
      </DndContext>

      {/* Footer */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {canWrite && (
          <>
            <Button
              onClick={() => save.mutate(draft)}
              disabled={!dirty || save.isPending}
            >
              {save.isPending ? "Saving…" : "Save faceplate"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setDraft(seed)
                setDirty(false)
                setSelectedGroup(null)
              }}
              disabled={!dirty}
            >
              Discard changes
            </Button>
            <Button variant="outline" onClick={() => setConfirmReset(true)}>
              Reset to auto
            </Button>
          </>
        )}
        {ghosts > 0 && (
          <span className="text-[11px] text-amber-700 dark:text-amber-300">
            {ghosts} slot{ghosts === 1 ? "" : "s"} reference missing templates —
            they render as ghosts.
          </span>
        )}
        {deviceType.faceplate === null && !dirty && (
          <span className="text-[11px] text-muted-foreground">
            No saved layout — showing the automatic one as a starting point.
          </span>
        )}
      </div>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to automatic layout?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes the saved faceplate for this device type. Devices go back
              to the automatic layout computed from their interfaces.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmReset(false)
                save.mutate(null)
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ─── pieces ─────────────────────────────────────────────────────────────────

/** mm-true cage box (visual only) — the same look as the device page's free
 * ports, sized by the connector family at builder scale. */
function cageStyle(family: ReturnType<typeof familyForType>) {
  const dims = CONNECTOR_MM[family]
  return {
    width: Math.round(dims.w * BUILDER_SCALE),
    height: Math.round(dims.h * BUILDER_SCALE),
  }
}

function PaletteCage({
  kind,
  template,
  disabled,
}: {
  kind: TemplateKind
  template: PortComponent
  disabled?: boolean
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `pal${SEP}${kind}${SEP}${template.name}`,
    disabled,
  })
  const family = familyForType(template.type ?? "")
  const rendered = renderTemplateName(template.name, null)
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title={`${template.name}${template.type ? ` · ${template.type}` : ""}`}
      style={cageStyle(family)}
      className={cn(
        "num flex cursor-grab items-center justify-center rounded-[3px] border border-border bg-muted/40 text-[9px] leading-none font-medium text-muted-foreground hover:border-primary hover:text-foreground",
        isDragging && "opacity-40",
        disabled && "cursor-default opacity-60"
      )}
    >
      {portNumber(rendered) ?? rendered.slice(0, 4)}
    </span>
  )
}

function BuilderCage({
  id,
  slot,
  gi,
  canWrite,
  templateIndex,
  onRemove,
}: {
  id: string
  slot: FaceplateSlot
  gi: number
  canWrite: boolean
  templateIndex: Map<string, PortComponent>
  onRemove: () => void
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !canWrite })

  if (slot.t === "label") {
    return (
      <span
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        {...attributes}
        {...listeners}
        onDoubleClick={onRemove}
        className={cn(
          "flex cursor-grab items-center px-0.5 font-mono text-[9px] whitespace-nowrap text-muted-foreground",
          isDragging && "opacity-40"
        )}
      >
        {slot.text}
      </span>
    )
  }

  const tpl =
    slot.t === "port"
      ? (templateIndex.get(
          `${slot.kind ?? "interface"}:${slot.name.toLowerCase()}`
        ) ?? null)
      : null
  const family =
    slot.t === "blank"
      ? (slot.family ?? "generic")
      : familyForType(tpl?.type ?? "")
  const ghost = slot.t === "port" && !tpl
  const rendered =
    slot.t === "port" ? renderTemplateName(slot.name, null) : null

  return (
    <span
      ref={setNodeRef}
      style={{
        ...cageStyle(family),
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      {...attributes}
      {...listeners}
      onDoubleClick={onRemove}
      title={
        slot.t === "port"
          ? `${slot.name}${tpl?.type ? ` · ${tpl.type}` : ""}${ghost ? " (missing template)" : ""}${(slot.kind ?? "interface") !== "interface" ? ` · ${slot.kind}` : ""}`
          : "blank cage"
      }
      className={cn(
        "num flex cursor-grab items-center justify-center rounded-[3px] border text-[9px] leading-none font-medium",
        slot.t === "blank"
          ? "border-dashed border-border/60 text-muted-foreground/40"
          : ghost
            ? "border-dashed border-amber-500/60 text-amber-700 dark:text-amber-300"
            : (slot.kind ?? "interface") !== "interface"
              ? "border-border bg-muted/60 text-muted-foreground"
              : "border-border bg-muted/40 text-muted-foreground hover:border-primary hover:text-foreground",
        isDragging && "opacity-40"
      )}
      data-gi={gi}
    >
      {rendered ? (portNumber(rendered) ?? rendered.slice(0, 4)) : ""}
    </span>
  )
}

function chunk<T>(list: T[], size: number): T[][] {
  if (size <= 0) return [list]
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function BuilderGroup({
  group: g,
  gi,
  selected,
  onSelect,
  canWrite,
  templateIndex,
  onRemoveSlot,
}: {
  group: FaceplateGroup
  gi: number
  selected: boolean
  onSelect: () => void
  canWrite: boolean
  templateIndex: Map<string, PortComponent>
  onRemoveSlot: (index: number) => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `group${SEP}${g.id}` })
  const ids = g.slots.map(
    (s, i) => `slot${SEP}${g.id}${SEP}${slotKey(s, gi, i)}`
  )
  const rowGap = Math.round(PANEL_MM.rowGap * BUILDER_SCALE)
  const banks = chunk(
    g.slots.map((s, i) => ({ s, i })),
    g.bank > 0 ? g.bank : g.slots.length || 1
  )

  return (
    <div
      ref={setNodeRef}
      onClick={onSelect}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-1 rounded-md p-1",
        selected && "ring-1 ring-primary/60",
        isOver && "bg-primary/5 ring-1 ring-primary/60"
      )}
    >
      <SortableContext items={ids} strategy={rectSortingStrategy}>
        <div
          className="flex items-center"
          style={{ gap: Math.round(PANEL_MM.bankGap * BUILDER_SCALE) }}
        >
          {g.slots.length === 0 && (
            <span className="px-2 py-3 text-[10px] text-muted-foreground">
              drop here
            </span>
          )}
          {banks.map((bank, bi) => (
            <div
              key={bi}
              className="grid grid-flow-col items-center justify-items-center"
              style={{
                gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))`,
                columnGap: 2,
                rowGap,
              }}
            >
              {bank.map(({ s, i }) => (
                <BuilderCage
                  key={ids[i]}
                  id={ids[i]}
                  slot={s}
                  gi={gi}
                  canWrite={canWrite}
                  templateIndex={templateIndex}
                  onRemove={() => onRemoveSlot(i)}
                />
              ))}
            </div>
          ))}
        </div>
      </SortableContext>
      <span className="num max-w-full truncate font-mono text-[9px] text-muted-foreground">
        {g.label ? renderTemplateName(g.label, null) : `group ${gi + 1}`}
        {" · "}
        {g.slots.length}
      </span>
    </div>
  )
}

function NewGroupZone({
  lane,
  onClick,
}: {
  /** Rack unit this zone creates groups in. */
  lane: number
  onClick: () => void
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `newgroup:${lane}` })
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-12 w-14 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:bg-muted/40",
        isOver && "border-primary/60 bg-primary/5 text-foreground"
      )}
      title="New group — click or drop a port"
    >
      <Plus className="h-4 w-4" />
    </button>
  )
}
