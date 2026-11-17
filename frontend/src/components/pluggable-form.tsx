import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { AccessoryCable, AccessoryType } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

/** Lines of a textarea as a list: trimmed, blanks dropped. */
export function linesOf(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

const num = (v: string): number | null => (v.trim() ? Number(v) : null)
const str = (v: number | null | undefined) => (v != null ? String(v) : "")

/** The cable block as the API takes it, or null for none. */
export function cablePayload(c: {
  profile: string
  jacket: string
  pitch: string
  bend: string
}): AccessoryCable | null {
  if (!c.profile) return null
  return {
    profile: c.profile as AccessoryCable["profile"],
    jacket_mm: Number(c.jacket),
    pitch_mm: c.profile === "zipcord" ? num(c.pitch) : null,
    min_bend_mm: num(c.bend),
  }
}

const PROFILE_OPTIONS = [
  { value: "zipcord", label: "Zip cord" },
  { value: "round", label: "Round" },
]

/**
 * Edit a pluggable part (docs/dcim/pluggables.md → Editing): what it fits,
 * its part numbers, standard, wavelength, reach and - a cord or plug - its
 * cable. Name, vendor, kind and connector stay the pack's. Each field
 * changed joins the part's "changed by hand" list, which a pack re-import
 * keeps.
 */
export function PluggableForm({
  part,
  onSaved,
  onCancel,
}: {
  part: AccessoryType
  onSaved: (p: AccessoryType) => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()
  const [fits, setFits] = useState(part.fits.join("\n"))
  const [parts, setParts] = useState(part.parts.join("\n"))
  const [standard, setStandard] = useState(part.standard)
  const [wavelength, setWavelength] = useState(str(part.wavelength_nm))
  const [reach, setReach] = useState(str(part.reach_m))
  const [profile, setProfile] = useState<string>(part.cable?.profile ?? "")
  const [jacket, setJacket] = useState(str(part.cable?.jacket_mm))
  const [pitch, setPitch] = useState(str(part.cable?.pitch_mm))
  const [bend, setBend] = useState(str(part.cable?.min_bend_mm))
  const hasCable = part.kind !== "transceiver"

  const mutation = useMutation({
    mutationFn: () =>
      saveObject<AccessoryType>({
        objectType: "api.accessorytype",
        endpoint: "/api/accessory-types/",
        id: part.id,
        payload: {
          fits: linesOf(fits).map((f) => f.toLowerCase()),
          parts: linesOf(parts),
          standard: standard.trim(),
          wavelength_nm: num(wavelength),
          reach_m: num(reach),
          ...(hasCable
            ? { cable: cablePayload({ profile, jacket, pitch, bend }) }
            : {}),
        },
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["pluggables"] })
      qc.invalidateQueries({ queryKey: ["pluggable", saved.id] })
      toast.success("Pluggable updated")
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })
  const cableError =
    typeof fieldErrors.cable === "string" ? fieldErrors.cable : undefined

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Part" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormTextarea
            label="Fits"
            hint="One port type per line"
            rows={4}
            value={fits}
            onChange={setFits}
            placeholder="10gbase-x-sfpp"
            error={fieldErrors.fits}
          />
          <FormTextarea
            label="Part numbers"
            hint="One per line"
            rows={4}
            value={parts}
            onChange={setParts}
            placeholder="SFP-10G-LR"
            error={fieldErrors.parts}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Standard"
            value={standard}
            onChange={setStandard}
            placeholder="10GBASE-LR"
            error={fieldErrors.standard}
          />
          <FormText
            label="Wavelength (nm)"
            type="number"
            value={wavelength}
            onChange={setWavelength}
            error={fieldErrors.wavelength_nm}
          />
          <FormText
            label="Reach (m)"
            type="number"
            value={reach}
            onChange={setReach}
            error={fieldErrors.reach_m}
          />
        </div>
      </FormSection>
      {hasCable && (
        <FormSection title="Cable" card>
          <div className="grid gap-3 @md:grid-cols-4">
            <FormSelect
              label="Profile"
              value={profile || null}
              onChange={(v) => setProfile(v ?? "")}
              noneLabel="No cable"
              options={PROFILE_OPTIONS}
              error={cableError}
            />
            <FormText
              label="Jacket (mm)"
              type="number"
              value={jacket}
              onChange={setJacket}
              disabled={!profile}
            />
            <FormText
              label="Pitch (mm)"
              type="number"
              value={pitch}
              onChange={setPitch}
              disabled={profile !== "zipcord"}
            />
            <FormText
              label="Minimum bend (mm)"
              type="number"
              value={bend}
              onChange={setBend}
              disabled={!profile}
            />
          </div>
        </FormSection>
      )}
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel="Save changes"
      />
    </form>
  )
}
