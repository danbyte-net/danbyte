import { useQuery } from "@tanstack/react-query"

import { apiAll } from "@/lib/api-all"
import {
  BASE_OPTIONS,
  DOOR_OPTIONS,
  FRAME_OPTIONS,
  HINGE_OPTIONS,
  LOOK_DEFAULTS,
  RACK_COLOURS,
  TOP_OPTIONS,
  isEnclosed,
  lookLabel,
} from "@/lib/rack-look"
import type { LookDraft, RackKitMini, RackLookFields } from "@/lib/rack-look"
import {
  FormCheckbox,
  FormColor,
  FormCombobox,
  FormSection,
  FormSelect,
  FormText,
} from "@/components/forms"
import { dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"

const COLOUR_OPTIONS = [
  ...Object.keys(RACK_COLOURS).map((c) => ({
    value: c,
    label: c[0].toUpperCase() + c.slice(1),
  })),
  { value: "custom", label: "Custom" },
]

const YES_NO = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
]

/**
 * The Look card of the rack type and rack forms (docs/dcim/racks.md →
 * Look). On a rack type every field has a value; on a rack (`inherit`
 * given) each one may be left to the type's, shown as the blank option.
 */
export function RackLookFields({
  value,
  onChange,
  inherit,
  errors,
}: {
  value: LookDraft
  onChange: (next: LookDraft) => void
  /** A rack's form: the Look its type (or the defaults) gives. */
  inherit?: Partial<RackLookFields> | null
  errors: Record<string, string | undefined>
}) {
  const isRack = inherit !== undefined
  const base: RackLookFields = { ...LOOK_DEFAULTS, ...(inherit ?? {}) }
  const set = (k: keyof LookDraft, v: string | null) =>
    onChange({ ...value, [k]: v ?? "" })
  const typeLabel = (k: keyof RackLookFields) =>
    isRack ? `Type's (${lookLabel(k, base[k])})` : undefined

  const kits = useQuery({
    queryKey: ["rack-kits-picker"],
    queryFn: () => apiAll<RackKitMini>("/api/rack-kits/"),
    staleTime: 10 * 60_000,
    retry: false,
  })

  const frame = value.frame || (isRack ? base.frame : "cabinet")
  const enclosed = isEnclosed(frame as RackLookFields["frame"])
  const named = value.colour === "" || value.colour in RACK_COLOURS
  const colourChoice = named ? value.colour : "custom"

  return (
    <FormSection title="Look" card>
      <div className="grid gap-3 @md:grid-cols-2">
        <FormSelect
          label="Frame"
          value={value.frame || null}
          onChange={(v) => set("frame", v)}
          noneLabel={typeLabel("frame")}
          options={FRAME_OPTIONS}
          error={errors.frame}
        />
        <FormText
          label="Rail depth (mm)"
          type="number"
          min={100}
          max={2000}
          placeholder={
            isRack && base.rail_depth_mm != null
              ? String(base.rail_depth_mm)
              : undefined
          }
          value={value.rail_depth_mm}
          onChange={(v) => set("rail_depth_mm", v)}
          error={errors.rail_depth_mm}
        />
        {enclosed && (
          <>
            <FormSelect
              label="Front door"
              value={value.front_door || null}
              onChange={(v) => set("front_door", v)}
              noneLabel={typeLabel("front_door")}
              options={DOOR_OPTIONS}
              error={errors.front_door}
            />
            <FormSelect
              label="Rear door"
              value={value.rear_door || null}
              onChange={(v) => set("rear_door", v)}
              noneLabel={typeLabel("rear_door")}
              options={DOOR_OPTIONS}
              error={errors.rear_door}
            />
            <FormSelect
              label="Hinge"
              value={value.hinge || null}
              onChange={(v) => set("hinge", v)}
              noneLabel={typeLabel("hinge")}
              options={HINGE_OPTIONS}
              error={errors.hinge}
            />
            {isRack && (
              <FormSelect
                label="Side panels"
                value={value.side_panels || null}
                onChange={(v) => set("side_panels", v)}
                noneLabel={typeLabel("side_panels")}
                options={YES_NO}
                error={errors.side_panels}
              />
            )}
            <FormSelect
              label="Top"
              value={value.top || null}
              onChange={(v) => set("top", v)}
              noneLabel={typeLabel("top")}
              options={TOP_OPTIONS}
              error={errors.top}
            />
          </>
        )}
        <FormSelect
          label="Base"
          value={value.base || null}
          onChange={(v) => set("base", v)}
          noneLabel={typeLabel("base")}
          options={BASE_OPTIONS}
          error={errors.base}
        />
        <FormSelect
          label="Colour"
          value={colourChoice || null}
          onChange={(v) =>
            set("colour", v === "custom" ? value.colour || "#1b1c1e" : v)
          }
          noneLabel={typeLabel("colour")}
          options={COLOUR_OPTIONS}
          error={named ? errors.colour : undefined}
        />
        {!named && (
          <FormColor
            label="Custom colour"
            value={value.colour}
            onChange={(v) => set("colour", v)}
            allowEmpty={false}
            error={errors.colour}
          />
        )}
        <FormCombobox
          label="Kit"
          value={value.kit_id || null}
          onChange={(v) => set("kit_id", v)}
          noneLabel={
            isRack
              ? base.kit
                ? `Type's (${lookLabel("kit", base.kit)})`
                : "Type's"
              : "No kit"
          }
          placeholder="Danbyte's own"
          searchPlaceholder="Search…"
          emptyText="No rack kits."
          options={(kits.data?.results ?? []).map((k) => ({
            value: k.id,
            label: lookLabel("kit", k),
          }))}
          error={errors.kit_id}
        />
        {isRack && (
          <FormSelect
            label="Blanking fill"
            value={value.blanking_fill || null}
            onChange={(v) => set("blanking_fill", v)}
            noneLabel={typeLabel("blanking_fill")}
            options={YES_NO}
            error={errors.blanking_fill}
          />
        )}
      </div>
      {!isRack && (
        <>
          {enclosed && (
            <FormCheckbox
              label="Side panels"
              checked={value.side_panels !== "no"}
              onChange={(v) => set("side_panels", v ? "yes" : "no")}
            />
          )}
          <FormCheckbox
            label="Blanking fill"
            info="Draws blanking panels in empty units in 3D. They are never devices and never count."
            checked={value.blanking_fill === "yes"}
            onChange={(v) => set("blanking_fill", v ? "yes" : "no")}
          />
        </>
      )}
    </FormSection>
  )
}

/** The Look as detail-card rows. On a rack (`inherited` given) a value
 * from its type reads muted. Doors, hinge, panels and top only for
 * enclosed frames. */
export function lookKvRows(
  look: RackLookFields,
  inherited?: readonly (keyof RackLookFields)[]
): KvRow[] {
  const keys: [keyof RackLookFields, string][] = [
    ["frame", "Frame"],
    ["rail_depth_mm", "Rail depth"],
    ...(isEnclosed(look.frame)
      ? ([
          ["front_door", "Front door"],
          ["rear_door", "Rear door"],
          ["hinge", "Hinge"],
          ["side_panels", "Side panels"],
          ["top", "Top"],
        ] as [keyof RackLookFields, string][])
      : []),
    ["base", "Base"],
    ["colour", "Colour"],
    ["kit", "Kit"],
    ["blanking_fill", "Blanking fill"],
  ]
  return keys.map(([k, label]) => {
    const v = look[k]
    const text = v === null ? null : lookLabel(k, v)
    return {
      label,
      value:
        text === null ? (
          dash
        ) : inherited?.includes(k) ? (
          <span className="text-muted-foreground">{text}</span>
        ) : (
          text
        ),
    }
  })
}
