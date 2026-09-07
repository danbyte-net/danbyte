import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type RouteTargetMini,
  type VRF,
  type VRFWritePayload,
} from "@/lib/api"
import { RtMultiSelect } from "@/components/cells/rt-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  Field,
  FormCheckbox,
  FormColor,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface VrfFormProps {
  vrf?: VRF
  /** Create-only: field values carried over from a source VRF via
   * GET /api/vrfs/<id>/clone/. Name + RD (the identity) start blank. */
  clone?: Partial<VRF>
  onSaved: (saved: VRF) => void
  onCancel: () => void
}

export function VrfForm({ vrf, clone, onSaved, onCancel }: VrfFormProps) {
  const isEdit = !!vrf
  // Cloneable fields read from the edit object or the clone seed; name and RD
  // deliberately read from `vrf` only, so a clone starts blank there.
  const src = vrf ?? clone
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(vrf?.name ?? "")
  const [rd, setRd] = useState(vrf?.rd ?? "")
  const [color, setColor] = useState(src?.color ?? "")
  const [description, setDescription] = useState(src?.description ?? "")
  const [enforceUnique, setEnforceUnique] = useState(
    src?.enforce_unique ?? true
  )
  const [importIds, setImportIds] = useState<string[]>(
    src?.import_targets?.map((t) => t.id) ?? []
  )
  const [exportIds, setExportIds] = useState<string[]>(
    src?.export_targets?.map((t) => t.id) ?? []
  )
  const [tagIds, setTagIds] = useState<number[]>(
    src?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    src?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!vrf) return
    setName(vrf.name)
    setRd(vrf.rd)
    setColor(vrf.color)
    setDescription(vrf.description)
    setEnforceUnique(vrf.enforce_unique)
    setImportIds(vrf.import_targets.map((t) => t.id))
    setExportIds(vrf.export_targets.map((t) => t.id))
    setTagIds(vrf.tags.map((t) => t.id))
    setCustomFields(vrf.custom_fields ?? {})
    reset()
  }, [vrf, reset])

  const rts = useQuery({
    queryKey: ["rts-picker"],
    queryFn: () =>
      api<Paginated<RouteTargetMini>>("/api/route-targets/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VRFWritePayload = {
        name: name.trim(),
        rd: rd.trim(),
        color: color.trim(),
        description: description.trim(),
        enforce_unique: enforceUnique,
        import_target_ids: importIds,
        export_target_ids: exportIds,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<VRF>({
        objectType: "api.vrf",
        endpoint: "/api/vrfs/",
        id: isEdit ? vrf!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vrfs"] })
      qc.invalidateQueries({ queryKey: ["vrfs-picker"] })
      qc.invalidateQueries({ queryKey: ["vrf", saved.id] })
      toast.success(
        isEdit ? `Updated VRF ${saved.name}` : `Created VRF ${saved.name}`
      )
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormSection title="VRF" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="prod-vpn"
          error={fieldErrors.name}
        />

        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Route Distinguisher"
            hint="RD"
            mono
            value={rd}
            onChange={setRd}
            placeholder="65001:100"
            error={fieldErrors.rd}
          />
          <FormColor
            label="Color"
            hint="pick or paste hex"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
        </div>

        <FormTextarea
          label="Description"
          rows={2}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Production east-coast L3VPN"
          error={fieldErrors.description}
        />

        <FormCheckbox
          label="Reject overlapping child prefixes within this VRF"
          checked={enforceUnique}
          onChange={setEnforceUnique}
        />
      </FormSection>

      <FormSection title="Route targets" card>
        <Field
          label="Import targets"
          hint="RTs whose routes this VRF accepts"
          error={fieldErrors.import_target_ids}
        >
          <RtMultiSelect
            options={rts.data?.results ?? []}
            value={importIds}
            onChange={setImportIds}
            placeholder="Add import RT…"
          />
        </Field>
        <Field
          label="Export targets"
          hint="RTs this VRF tags its own routes with"
          error={fieldErrors.export_target_ids}
        >
          <RtMultiSelect
            options={rts.data?.results ?? []}
            value={exportIds}
            onChange={setExportIds}
            placeholder="Add export RT…"
          />
        </Field>
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="vrf"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create VRF"}
      />
    </form>
  )
}
