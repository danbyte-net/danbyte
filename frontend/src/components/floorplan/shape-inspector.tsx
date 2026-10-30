import { useEffect, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"
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

import { apiAll } from "@/lib/api-all"
import type {
  FloorPlan,
  FloorPlanAreaBorder,
  FloorPlanLabelColor,
  Location,
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

import {
  LABEL_COLORS,
  LABEL_SIZES,
  areaColor,
  labelPresetMm,
  labelPresetOf,
} from "./shapes"
import type { AreaShape, LabelShape, PlanShape } from "./shapes"
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
 * it, at its site. */
function useFloorLocations(plan: FloorPlan) {
  const q = useQuery({
    queryKey: ["locations-of-site", plan.site.id],
    queryFn: () => apiAll<Location>(`/api/locations/?site=${plan.site.id}`),
    staleTime: 5 * 60_000,
  })
  return useMemo(() => {
    const all = q.data?.results ?? []
    const inside = new Set([plan.location.id])
    // Parents before children is not guaranteed: walk until nothing joins.
    for (let grew = true; grew;) {
      grew = false
      for (const l of all)
        if (l.parent && inside.has(l.parent.id) && !inside.has(l.id)) {
          inside.add(l.id)
          grew = true
        }
    }
    return all.filter((l) => inside.has(l.id))
  }, [q.data, plan.location.id])
}

type LinkKind = "room" | "location" | "none"

/** An area's inspector: what it stands for (a room, a location or
 * nothing), its name and look. */
export function AreaInspector({
  plan,
  area,
  onChange,
  onRestack,
  onDelete,
}: {
  plan: FloorPlan
  area: AreaShape
  onChange: Patch
  onRestack: (dir: 1 | -1) => void
  onDelete: () => void
}) {
  // The floor's rooms, its sub-locations' included.
  const rooms = useQuery({
    queryKey: ["rooms-picker", plan.location.id, "descendants"],
    queryFn: () =>
      apiAll<RoomOption>(
        `/api/rooms/?picker=1&location=${plan.location.id}&include_descendants=1`
      ),
    staleTime: 5 * 60_000,
  })
  const locations = useFloorLocations(plan)
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
    onChange({ room: null, location: null })
    if (kind === "location") {
      const own = locations.find((l) => l.id === plan.location.id)
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
        />
      )}
      <Field label="Name" hint="optional">
        <Input
          value={area.label}
          maxLength={64}
          placeholder={area.room?.name || area.location?.name || ""}
          onChange={(e) => onChange({ label: e.target.value })}
        />
      </Field>
      {/* A linked area wears its room's or location's colour. */}
      {link === "none" && (
        <Field label="Colour">
          <ColorPicker
            value={area.color}
            onChange={(color) => onChange({ color })}
          />
        </Field>
      )}
      {link !== "none" && (area.room || area.location) && (
        <Field label="Colour" hint={`from the ${link}`}>
          <ColorBadge
            name={area.room?.name ?? area.location?.name ?? ""}
            color={areaColor(area)}
            className="max-w-full self-start"
          />
        </Field>
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
}: {
  plan: FloorPlan
  label: LabelShape
  onChange: Patch
  onRestack: (dir: 1 | -1) => void
  onDelete: () => void
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
      <AngleField
        value={label.rotation}
        onChange={(rotation) => onChange({ rotation })}
      />
    </aside>
  )
}
