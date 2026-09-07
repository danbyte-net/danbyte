import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Aggregate,
  type AggregateWritePayload,
  type Paginated,
  type RIROption,
} from "@/lib/api"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  FormDate,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface AggregateFormProps {
  aggregate?: Aggregate
  onSaved: (saved: Aggregate) => void
  onCancel: () => void
}

export function AggregateForm({
  aggregate,
  onSaved,
  onCancel,
}: AggregateFormProps) {
  const isEdit = !!aggregate
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [prefix, setPrefix] = useState(aggregate?.prefix ?? "")
  const [rirId, setRirId] = useState<string | null>(aggregate?.rir?.id ?? null)
  const [dateAdded, setDateAdded] = useState(aggregate?.date_added ?? "")
  const [description, setDescription] = useState(aggregate?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    aggregate?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    aggregate?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!aggregate) return
    setPrefix(aggregate.prefix)
    setRirId(aggregate.rir?.id ?? null)
    setDateAdded(aggregate.date_added ?? "")
    setDescription(aggregate.description)
    setTagIds(aggregate.tags.map((t) => t.id))
    setCustomFields(aggregate.custom_fields ?? {})
    reset()
  }, [aggregate, reset])

  const rirs = useQuery({
    queryKey: ["rirs-picker"],
    queryFn: () => api<Paginated<RIROption>>("/api/rirs/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: AggregateWritePayload = {
        prefix: prefix.trim(),
        rir_id: rirId ?? "",
        date_added: dateAdded || null,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Aggregate>({
        objectType: "api.aggregate",
        endpoint: "/api/aggregates/",
        id: isEdit ? aggregate!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["aggregates"] })
      qc.invalidateQueries({ queryKey: ["aggregate", saved.id] })
      qc.invalidateQueries({ queryKey: ["rir-aggregates"] })
      toast.success(
        isEdit ? `Updated ${saved.prefix}` : `Created ${saved.prefix}`
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
        // The API requires an RIR (rir_id has no default) - the old form
        // disabled Save until one was picked; the shared footer has no
        // disabled state, so guard here and say why.
        if (!rirId) {
          toast.error("Pick the RIR this block is allocated by.")
          return
        }
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormSection title="Aggregate" card>
        <FormText
          label="Prefix"
          required
          hint="CIDR"
          autoFocus={!isEdit}
          mono
          value={prefix}
          onChange={setPrefix}
          placeholder="10.0.0.0/8"
          error={fieldErrors.prefix}
        />

        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="RIR"
            required
            value={rirId}
            onChange={setRirId}
            options={(rirs.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
            }))}
            placeholder="Select a RIR"
            error={fieldErrors.rir_id}
          />
          <FormDate
            label="Date added"
            value={dateAdded}
            onChange={setDateAdded}
            error={fieldErrors.date_added}
          />
        </div>

        <FormTextarea
          label="Description"
          rows={3}
          value={description}
          onChange={setDescription}
          placeholder="e.g. RFC1918 private block"
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
        model="aggregate"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create aggregate"}
      />
    </form>
  )
}
