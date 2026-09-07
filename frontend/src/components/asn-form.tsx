import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type ASN,
  type ASNWritePayload,
  type Paginated,
  type RIROption,
} from "@/lib/api"
import { SiteMultiSelect } from "@/components/cells/site-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  Field,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface AsnFormProps {
  asn?: ASN
  onSaved: (saved: ASN) => void
  onCancel: () => void
}

export function AsnForm({ asn, onSaved, onCancel }: AsnFormProps) {
  const isEdit = !!asn
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [number, setNumber] = useState(asn ? String(asn.asn) : "")
  const [rirId, setRirId] = useState<string | null>(asn?.rir?.id ?? null)
  const [siteIds, setSiteIds] = useState<string[]>(
    asn?.sites.map((s) => s.id) ?? []
  )
  const [description, setDescription] = useState(asn?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    asn?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    asn?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!asn) return
    setNumber(String(asn.asn))
    setRirId(asn.rir?.id ?? null)
    setSiteIds(asn.sites.map((s) => s.id))
    setDescription(asn.description)
    setTagIds(asn.tags.map((t) => t.id))
    setCustomFields(asn.custom_fields ?? {})
    reset()
  }, [asn, reset])

  const rirs = useQuery({
    queryKey: ["rirs-picker"],
    queryFn: () => api<Paginated<RIROption>>("/api/rirs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const sites = useSiteOptions()

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ASNWritePayload = {
        asn: Number(number),
        rir_id: rirId,
        site_ids: siteIds,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<ASN>({
        objectType: "api.asn",
        endpoint: "/api/asns/",
        id: isEdit ? asn!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["asns"] })
      qc.invalidateQueries({ queryKey: ["asn", saved.id] })
      toast.success(
        isEdit ? `Updated AS${saved.asn}` : `Created AS${saved.asn}`
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
      <FormSection title="ASN" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="AS number"
            required
            autoFocus={!isEdit}
            type="number"
            inputMode="numeric"
            min={1}
            max={4294967295}
            mono
            value={number}
            onChange={setNumber}
            placeholder="65001"
            error={fieldErrors.asn}
          />
          <FormSelect
            label="RIR"
            value={rirId}
            onChange={setRirId}
            options={(rirs.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
            }))}
            noneLabel="No RIR"
            placeholder="No RIR"
            error={fieldErrors.rir_id}
          />
        </div>

        <Field label="Sites" error={fieldErrors.site_ids}>
          <SiteMultiSelect
            options={sites.options}
            value={siteIds}
            onChange={setSiteIds}
          />
        </Field>

        <FormTextarea
          label="Description"
          rows={3}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Edge / transit AS"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="asn"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create ASN"}
      />
    </form>
  )
}
