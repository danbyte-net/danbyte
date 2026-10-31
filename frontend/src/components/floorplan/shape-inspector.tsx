import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  Lock,
  LockOpen,
  Trash2,
} from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import {
  scopeKey,
  scopeLocationIds,
  scopeRoomsUrl,
} from "@/lib/floor-plan-scope"
import { QuickAddDialog } from "@/components/forms/quick-add"
import type {
  AreaTypeRef,
  FloorPlan,
  FloorPlanAreaBorder,
  FloorPlanBackLabelRef,
  FloorPlanLabelColor,
  Location,
  LocationTypeRef,
  RoomOption,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { BarIconButton } from "@/components/map-toolbar"
import { ColorPicker } from "@/components/ui/color-picker"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormSelect,
} from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { cn } from "@/lib/utils"

import { OpensEditor } from "./opens-field"
import {
  LABEL_COLORS,
  LABEL_SIZES,
  areaName,
  enclosingLocation,
  labelPlate,
  labelPresetMm,
  labelPresetOf,
} from "./shapes"
import type { AreaShape, LabelShape, PlanShape } from "./shapes"
import { floorPlanContentsKey } from "./use-floor-plan-data"
import { NEW_LABEL_TEXT } from "./use-shape-edits"

type Patch = (patch: Partial<PlanShape>) => void

const r1 = (v: number) => Math.round(v * 10) / 10

/** The inspector's head: what is selected, and its order, lock and delete
 * buttons. */
function Head({
  title,
  shape,
  onChange,
  onRestack,
  onDelete,
}: {
  title: string
  shape: PlanShape
  onChange: Patch
  onRestack: (dir: 1 | -1) => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-auto text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
        {title}
      </span>
      <BarIconButton label="Bring forward" onClick={() => onRestack(1)}>
        <ArrowUpToLine />
      </BarIconButton>
      <BarIconButton label="Send back" onClick={() => onRestack(-1)}>
        <ArrowDownToLine />
      </BarIconButton>
      <BarIconButton
        label={shape.locked ? "Unlock" : "Lock"}
        aria-pressed={shape.locked}
        onClick={() => onChange({ locked: !shape.locked })}
      >
        {shape.locked ? <Lock /> : <LockOpen />}
      </BarIconButton>
      <BarIconButton label="Delete" destructive onClick={onDelete}>
        <Trash2 />
      </BarIconButton>
    </div>
  )
}

/** A whole-degree angle field. */
function AngleField({
  value,
  onChange,
}: {
  value: number
  onChange: (deg: number) => void
}) {
  return (
    <Field label="Rotation" hint="degrees">
      <Input
        type="number"
        min={0}
        max={359}
        value={r1(value)}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (Number.isFinite(v)) onChange(((v % 360) + 360) % 360)
        }}
      />
    </Field>
  )
}

/** The locations an area may stand for: the floor's own and those inside
 * it, at its site - every location of it on a site-wide floor. */
function useFloorLocations(plan: FloorPlan) {
  const q = useQuery({
    queryKey: ["locations-of-site", plan.site.id],
    queryFn: () => apiAll<Location>(`/api/locations/?site=${plan.site.id}`),
    staleTime: 5 * 60_000,
  })
  return useMemo(() => {
    const all = q.data?.results ?? []
    const inside = scopeLocationIds(plan, all)
    return all.filter((l) => inside.has(l.id))
  }, [q.data, plan])
}

const locationOptions = (rows: Location[]) =>
  rows.map((l) => ({
    value: l.id,
    label: l.name,
    color: l.color || null,
    badge: true,
  }))

/** "+" on the Room picker: a room in the floor's location - on a site-wide
 * floor, in the location picked in the dialog (the one drawn around the
 * area first). */
function NewRoomButton({
  plan,
  locations,
  defaultLocationId,
  onCreated,
}: {
  plan: FloorPlan
  locations: Location[]
  defaultLocationId: string | null
  onCreated: (room: { id: string; name: string }) => void
}) {
  const qc = useQueryClient()
  const done = (r: { id: string; name: string }) => {
    void qc.invalidateQueries({ queryKey: ["rooms-picker"] })
    void qc.invalidateQueries({ queryKey: ["rooms"] })
    onCreated(r)
  }
  if (plan.location)
    return (
      <QuickAddDialog
        title={`New room in ${plan.location.name}`}
        endpoint="/api/rooms/"
        fields={[{ name: "name", label: "Name", required: true }]}
        fixed={{ location_id: plan.location.id }}
        onCreated={done}
      />
    )
  return (
    <QuickAddDialog
      title={`New room at ${plan.site.name}`}
      endpoint="/api/rooms/"
      fields={[
        { name: "name", label: "Name", required: true },
        {
          name: "location_id",
          label: "Location",
          type: "combobox",
          required: true,
          options: locationOptions(locations),
          initial: defaultLocationId ?? undefined,
          placeholder: "Select a location…",
        },
      ]}
      onCreated={done}
    />
  )
}

/** "+" on the Location picker: a location at the floor's site (inside the
 * floor's location by default), its parent and type optional. */
function NewLocationButton({
  plan,
  locations,
  onCreated,
}: {
  plan: FloorPlan
  locations: Location[]
  onCreated: (loc: { id: string; name: string; color?: string }) => void
}) {
  const qc = useQueryClient()
  const types = useQuery({
    queryKey: ["location-types-picker"],
    queryFn: () => apiAll<LocationTypeRef>("/api/location-types/?picker=1"),
    staleTime: 5 * 60_000,
  })
  return (
    <QuickAddDialog
      title={`New location at ${plan.site.name}`}
      endpoint="/api/locations/"
      fixed={{ site_id: plan.site.id }}
      fields={[
        { name: "name", label: "Name", required: true },
        {
          name: "parent_id",
          label: "Parent",
          type: "combobox",
          options: locationOptions(locations),
          initial: plan.location?.id,
          noneLabel: "No parent",
          placeholder: "Select a parent…",
        },
        {
          name: "location_type_id",
          label: "Location type",
          type: "combobox",
          options: (types.data?.results ?? []).map((t) => ({
            value: t.id,
            label: t.name,
            color: t.color || null,
            badge: true,
          })),
          noneLabel: "No type",
          placeholder: "Select a type…",
        },
      ]}
      onCreated={(l) => {
        void qc.invalidateQueries({ queryKey: ["locations-of-site"] })
        void qc.invalidateQueries({ queryKey: ["locations"] })
        onCreated(l)
      }}
    />
  )
}

type LinkKind = "room" | "location" | "none"

/** The colour of the room or location an area stands for - the object's
 * own, so a change repaints every area of it. Changed through the object's
 * endpoint (its change grant, its change log); read-only without it. */
function LinkColourField({
  plan,
  kind,
  obj,
  onColour,
}: {
  plan: FloorPlan
  kind: "room" | "location"
  obj: { id: string; name: string; color: string }
  onColour?: (kind: "room" | "location", id: string, color: string) => void
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const save = useMutation({
    mutationFn: (color: string) =>
      api(`/api/${kind === "room" ? "rooms" : "locations"}/${obj.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ color }),
      }),
    onSuccess: (_d, color) => {
      onColour?.(kind, obj.id, color)
      for (const key of [
        ["rooms-picker"],
        ["rooms"],
        ["locations-of-site"],
        ["locations"],
        floorPlanContentsKey(plan.id),
        ["floor-plan-placeable", plan.id],
      ])
        void qc.invalidateQueries({ queryKey: key })
    },
    onError: (err) => apiErrorToast(err),
  })
  const timer = useRef<number | null>(null)
  const pending = useRef<string | null>(null)
  const flush = () => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    if (pending.current) save.mutate(pending.current)
    pending.current = null
  }
  // Leaving the area (another selected) still writes a pending colour.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => () => flushRef.current(), [])
  const label = kind === "room" ? "Room colour" : "Location colour"
  return (
    <Field
      label={label}
      info={`The ${kind}'s own colour: changing it repaints every area of ${obj.name} and its badge everywhere.`}
    >
      {canDo(kind, "change") ? (
        <ColorPicker
          value={obj.color}
          allowEmpty={false}
          onChange={(color) => {
            // The native picker reports every step of a drag: write the
            // colour it settles on.
            if (timer.current) window.clearTimeout(timer.current)
            pending.current = color && color !== obj.color ? color : null
            if (pending.current) timer.current = window.setTimeout(flush, 400)
          }}
        />
      ) : (
        <ColorBadge
          name={obj.name}
          color={obj.color}
          className="max-w-full self-start"
        />
      )}
    </Field>
  )
}

/** A plain area's type (parking, fence…): the tenant's area types as their
 * colour badges, with "+" to make one there and then. */
function AreaTypeField({
  area,
  onChange,
}: {
  area: AreaShape
  onChange: Patch
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const types = useQuery({
    queryKey: ["area-types-picker"],
    queryFn: () => apiAll<AreaTypeRef>("/api/area-types/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const rows = types.data?.results ?? []
  return (
    <FormCombobox
      label="Type"
      hint="optional"
      value={area.area_type?.id ?? null}
      onChange={(id) =>
        onChange({ area_type: rows.find((t) => t.id === id) ?? null })
      }
      options={rows.map((t) => ({
        value: t.id,
        label: t.name,
        color: t.color || null,
        badge: true,
      }))}
      noneLabel="No type"
      placeholder="Select a type…"
      searchPlaceholder="Search types…"
      emptyText="No area types."
      quickAdd={
        canDo("areatype", "add") ? (
          <QuickAddDialog
            title="New area type"
            endpoint="/api/area-types/"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]}
            onCreated={(t) => {
              void qc.invalidateQueries({ queryKey: ["area-types-picker"] })
              void qc.invalidateQueries({ queryKey: ["area-types"] })
              const made = t as Partial<AreaTypeRef> & {
                id: string
                name: string
              }
              onChange({
                area_type: {
                  id: made.id,
                  name: made.name,
                  color: made.color ?? "",
                  pattern: made.pattern ?? "solid",
                  icon: made.icon ?? "",
                },
              })
            }}
          />
        ) : undefined
      }
    />
  )
}

/** An area's inspector: what it stands for (a room, a location or
 * nothing), its name and look. */
export function AreaInspector({
  plan,
  area,
  onChange,
  onRestack,
  onDelete,
  onLinkColour,
  shapes = [],
  onBackLabel,
}: {
  plan: FloorPlan
  area: AreaShape
  onChange: Patch
  onRestack: (dir: 1 | -1) => void
  onDelete: () => void
  /** A room's or location's colour was changed: repaint its areas. */
  onLinkColour?: (kind: "room" | "location", id: string, color: string) => void
  /** The floor's areas and labels: the location drawn around this area,
   * the area a label's snapshot is of. */
  shapes?: readonly PlanShape[]
  /** Its Back button's label changed on the server. */
  onBackLabel?: (ref: FloorPlanBackLabelRef | null) => void
}) {
  // The floor's rooms, its sub-locations' included.
  const rooms = useQuery({
    queryKey: ["rooms-picker", scopeKey(plan), "descendants"],
    queryFn: () => apiAll<RoomOption>(scopeRoomsUrl(plan)),
    staleTime: 5 * 60_000,
  })
  const locations = useFloorLocations(plan)
  const { canDo } = useMe()
  const canAddRoom = canDo("room", "add")
  const canAddLocation = canDo("location", "add")
  const linked: LinkKind = area.room
    ? "room"
    : area.location
      ? "location"
      : "none"
  // The tab picked before a room or location is: "Room" waits for one.
  const [tab, setTab] = useState<LinkKind>(linked)
  useEffect(() => setTab(linked), [area.id])
  const link = linked !== "none" ? linked : tab
  const setLink = (kind: LinkKind) => {
    setTab(kind)
    if (kind === link) return
    // A type is for plain areas: linking one drops it.
    onChange({ room: null, location: null, area_type: null })
    if (kind === "location") {
      const own = locations.find((l) => l.id === plan.location?.id)
      if (own)
        onChange({
          location: { id: own.id, name: own.name, color: own.color },
        })
    }
  }
  return (
    <aside
      aria-label="Area"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4"
    >
      <Head
        title={area.shape === "polygon" ? "Area · polygon" : "Area"}
        shape={area}
        onChange={onChange}
        onRestack={onRestack}
        onDelete={onDelete}
      />
      <Field label="Stands for">
        <SegmentedTabs<LinkKind>
          value={link}
          onValueChange={setLink}
          items={[
            { value: "room", label: "Room" },
            { value: "location", label: "Location" },
            { value: "none", label: "Just an area" },
          ]}
          wrap
        />
      </Field>
      {link === "room" && (
        <FormCombobox
          label="Room"
          value={area.room?.id ?? null}
          onChange={(id) => {
            const r = rooms.data?.results.find((x) => x.id === id)
            onChange({
              room: r
                ? { id: r.id, name: r.name, code: r.code, color: r.color }
                : null,
            })
          }}
          options={(rooms.data?.results ?? []).map((r) => ({
            value: r.id,
            label: r.name,
            color: r.color || null,
            badge: true,
          }))}
          placeholder="Select a room…"
          searchPlaceholder="Search rooms…"
          emptyText="No rooms in this location."
          quickAdd={
            canAddRoom ? (
              <NewRoomButton
                plan={plan}
                locations={locations}
                defaultLocationId={
                  enclosingLocation(area, shapes, plan.cell_mm)?.id ?? null
                }
                onCreated={(r) =>
                  onChange({
                    room: { id: r.id, name: r.name, code: "", color: "" },
                  })
                }
              />
            ) : undefined
          }
        />
      )}
      {link === "location" && (
        <FormCombobox
          label="Location"
          value={area.location?.id ?? null}
          onChange={(id) => {
            const l = locations.find((x) => x.id === id)
            onChange({
              location: l ? { id: l.id, name: l.name, color: l.color } : null,
            })
          }}
          options={locations.map((l) => ({
            value: l.id,
            label: l.name,
            color: l.color || null,
            badge: true,
          }))}
          placeholder="Select a location…"
          searchPlaceholder="Search locations…"
          quickAdd={
            canAddLocation ? (
              <NewLocationButton
                plan={plan}
                locations={locations}
                onCreated={(l) =>
                  onChange({
                    location: { id: l.id, name: l.name, color: l.color ?? "" },
                  })
                }
              />
            ) : undefined
          }
        />
      )}
      {link === "none" && <AreaTypeField area={area} onChange={onChange} />}
      <Field label="Name" hint="optional">
        <Input
          value={area.label}
          maxLength={64}
          placeholder={areaName({ ...area, label: "" })}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </Field>
      {/* A linked area wears its room's or location's colour; a plain one
          its own, else its type's. */}
      {link === "none" && (
        <Field
          label="Colour"
          info={
            area.area_type
              ? `Blank: the ${area.area_type.name} type's colour.`
              : undefined
          }
        >
          <ColorPicker
            value={area.color}
            onChange={(color) => onChange({ color })}
          />
        </Field>
      )}
      {link === "room" && area.room && (
        <LinkColourField
          plan={plan}
          kind="room"
          obj={area.room}
          onColour={onLinkColour}
        />
      )}
      {link === "location" && area.location && (
        <LinkColourField
          plan={plan}
          kind="location"
          obj={area.location}
          onColour={onLinkColour}
        />
      )}
      <Field label="Fill" hint={`${area.fill_opacity}%`}>
        <Slider
          className="mt-1.5"
          value={[area.fill_opacity]}
          min={0}
          max={100}
          step={5}
          onValueChange={([v]) => onChange({ fill_opacity: v })}
          aria-label="Fill"
        />
      </Field>
      <FormSelect
        label="Border"
        value={area.border}
        onChange={(v) => onChange({ border: v as FloorPlanAreaBorder })}
        options={[
          { value: "solid", label: "Solid" },
          { value: "dashed", label: "Dashed" },
          { value: "none", label: "None" },
        ]}
      />
      <FormCheckbox
        label="Show the name"
        checked={area.show_name}
        onChange={(v) => onChange({ show_name: v })}
      />
      <OpensEditor
        plan={plan}
        shape={area}
        shapes={shapes}
        onChange={onChange}
        onBackLabel={onBackLabel}
      />
      {area.shape === "rect" && (
        <AngleField
          value={area.rotation}
          onChange={(rotation) => onChange({ rotation })}
        />
      )}
    </aside>
  )
}

/** A label's inspector: its text, size (presets or millimetres), weight,
 * alignment, colour and plate. */
export function LabelInspector({
  plan,
  label,
  onChange,
  onRestack,
  onDelete,
  shapes = [],
  onBackLabel,
}: {
  plan: FloorPlan
  label: LabelShape
  onChange: Patch
  onRestack: (dir: 1 | -1) => void
  onDelete: () => void
  shapes?: readonly PlanShape[]
  onBackLabel?: (ref: FloorPlanBackLabelRef | null) => void
}) {
  const text = useRef<HTMLTextAreaElement>(null)
  // A new label opens with its text selected, so typing replaces it.
  useEffect(() => {
    if (label.text === NEW_LABEL_TEXT && text.current) {
      text.current.focus()
      text.current.select()
    }
  }, [label.id])
  const preset = labelPresetOf(label.font_mm, plan.cell_mm)
  return (
    <aside
      aria-label="Label"
      className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4"
    >
      <Head
        title="Label"
        shape={label}
        onChange={onChange}
        onRestack={onRestack}
        onDelete={onDelete}
      />
      <Field label="Text">
        <Textarea
          ref={text}
          rows={3}
          maxLength={500}
          value={label.text}
          onChange={(e) => onChange({ text: e.target.value })}
        />
      </Field>
      <Field label="Size" hint="mm on the floor">
        <div className="flex items-center gap-2">
          <SegmentedTabs<string>
            value={preset ?? ""}
            onValueChange={(k) =>
              onChange({
                font_mm: labelPresetMm(
                  k as (typeof LABEL_SIZES)[number]["key"],
                  plan.cell_mm
                ),
              })
            }
            items={LABEL_SIZES.map((s) => ({ value: s.key, label: s.key }))}
          />
          <Input
            type="number"
            aria-label="Text height in millimetres"
            className="w-20"
            min={20}
            max={5000}
            value={label.font_mm}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value))
              if (Number.isFinite(v) && v >= 20 && v <= 5000)
                onChange({ font_mm: v })
            }}
          />
        </div>
      </Field>
      <div className="flex items-center gap-1">
        <BarIconButton
          label="Bold"
          aria-pressed={label.weight === "bold"}
          className={cn(label.weight === "bold" && "bg-accent")}
          onClick={() =>
            onChange({ weight: label.weight === "bold" ? "normal" : "bold" })
          }
        >
          <Bold />
        </BarIconButton>
        {(
          [
            ["left", AlignLeft, "Align left"],
            ["center", AlignCenter, "Centre"],
            ["right", AlignRight, "Align right"],
          ] as const
        ).map(([align, Icon, tip]) => (
          <BarIconButton
            key={align}
            label={tip}
            aria-pressed={label.align === align}
            className={cn(label.align === align && "bg-accent")}
            onClick={() => onChange({ align })}
          >
            <Icon />
          </BarIconButton>
        ))}
      </div>
      <Field label="Colour">
        <div className="flex flex-wrap gap-1">
          {(Object.keys(LABEL_COLORS) as FloorPlanLabelColor[]).map((c) => (
            <button
              key={c || "ink"}
              type="button"
              aria-pressed={label.color === c}
              aria-label={LABEL_COLORS[c].name}
              onClick={() => onChange({ color: c })}
              className={cn(
                "flex h-7 w-8 items-center justify-center rounded-md border border-border text-sm font-semibold hover:bg-muted/60",
                label.color === c && "border-primary/60 bg-accent"
              )}
            >
              <svg width="16" height="14" aria-hidden>
                <text
                  x="1"
                  y="12"
                  fontSize="13"
                  className={LABEL_COLORS[c].className}
                >
                  Aa
                </text>
              </svg>
            </button>
          ))}
        </div>
      </Field>
      <FormCheckbox
        label="Plate behind the text"
        checked={label.plate}
        onChange={(v) => onChange({ plate: v })}
      />
      {label.plate && (
        <Field
          label="Plate colour"
          info="The text reads over it unless its own colour is set."
        >
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Plate colour"
          >
            {(Object.keys(LABEL_COLORS) as FloorPlanLabelColor[]).map((c) => {
              const look = labelPlate({ ...label, plate: true, plate_color: c })
              const name = c ? LABEL_COLORS[c].name : "Default"
              const on = (label.plate_color ?? "") === c
              return (
                <button
                  key={c || "default"}
                  type="button"
                  aria-pressed={on}
                  aria-label={name}
                  onClick={() => onChange({ plate_color: c })}
                  className={cn(
                    "flex h-7 w-8 items-center justify-center rounded-md border border-border hover:bg-muted/60",
                    on && "border-primary/60 bg-accent"
                  )}
                >
                  <span
                    className={cn(
                      "flex h-4 w-6 items-center justify-center rounded-md border border-border text-[9px] font-semibold",
                      !look.fill && "bg-background"
                    )}
                    style={
                      look.fill
                        ? {
                            background: look.fill,
                            color: look.ink ?? undefined,
                          }
                        : undefined
                    }
                  >
                    Aa
                  </span>
                </button>
              )
            })}
          </div>
        </Field>
      )}
      <AngleField
        value={label.rotation}
        onChange={(rotation) => onChange({ rotation })}
      />
      <OpensEditor
        plan={plan}
        shape={label}
        shapes={shapes}
        onChange={onChange}
        onBackLabel={onBackLabel}
      />
    </aside>
  )
}
