import {
  EAR_MM_MAX,
  EAR_MM_MIN,
  EAR_PLATE_MM,
  EAR_POSITION_LABELS,
  EAR_POSITIONS,
} from "@/lib/rack-mount"
import type { EarPosition, RackMountDraft, RailKind } from "@/lib/rack-mount"
import {
  FormCheckbox,
  FormSection,
  FormSelect,
  FormText,
} from "@/components/forms"

const RAILS: { value: RailKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "fixed", label: "Fixed" },
  { value: "sliding", label: "Sliding" },
]

/** A device type's rack mounting (docs/dcim/device-catalog.md → Rack
 * mounting): its ears and the positions they fit at - the faceplate's
 * distance in front of the ear plane, mm (Reversed: the rear face's, the
 * box turned round) - its ear plate thickness and its rail kit. */
export function RackMountFields({
  value,
  onChange,
  error,
}: {
  value: RackMountDraft
  onChange: (next: RackMountDraft) => void
  error?: string
}) {
  const set = (patch: Partial<RackMountDraft>) =>
    onChange({ ...value, ...patch })
  const offered = EAR_POSITIONS.filter((p) => value[p].trim() !== "")
  return (
    <FormSection title="Rack mounting" card>
      <FormCheckbox
        label="Rack ears"
        checked={value.ears}
        onChange={(ears) => set({ ears })}
      />
      {value.ears && (
        <div className="grid gap-3 @md:grid-cols-4">
          {EAR_POSITIONS.map((p) => (
            <FormText
              key={p}
              label={`${EAR_POSITION_LABELS[p]} (mm)`}
              info={
                p === "reversed"
                  ? "Turned round: rear face in front of the ear plane. Blank: not offered."
                  : "Faceplate in front of the ear plane. Blank: not offered."
              }
              type="number"
              min={-2000}
              max={2000}
              value={value[p]}
              onChange={(v) => set({ [p]: v })}
            />
          ))}
        </div>
      )}
      <div className="grid gap-3 @md:grid-cols-3">
        {value.ears && (
          <FormSelect
            label="Default position"
            value={value.default || null}
            onChange={(v) => set({ default: (v ?? "") as EarPosition | "" })}
            noneLabel="First offered"
            options={offered.map((p) => ({
              value: p,
              label: EAR_POSITION_LABELS[p],
            }))}
          />
        )}
        {value.ears && (
          <FormText
            label="Ear plate (mm)"
            info={`Plate thickness, ${EAR_MM_MIN}-${EAR_MM_MAX} mm. Blank: ${EAR_PLATE_MM}.`}
            type="number"
            min={EAR_MM_MIN}
            max={EAR_MM_MAX}
            step={0.5}
            value={value.ear_mm}
            onChange={(v) => set({ ear_mm: v })}
          />
        )}
        <FormSelect
          label="Rails"
          value={value.rails}
          onChange={(v) => set({ rails: (v ?? "none") as RailKind })}
          options={RAILS}
          error={error}
        />
      </div>
    </FormSection>
  )
}
