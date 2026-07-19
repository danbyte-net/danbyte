import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PowerPanel,
  type PowerPanelWritePayload,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

export interface PowerPanelFormProps {
  panel?: PowerPanel
  onSaved: (v: PowerPanel) => void
  onCancel: () => void
}

export function PowerPanelForm({
  panel,
  onSaved,
  onCancel,
}: PowerPanelFormProps) {
  const isEdit = !!panel
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(panel?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(panel?.site?.id ?? null)
  const [comments, setComments] = useState(panel?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    panel?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    panel?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!panel) return
    setName(panel.name)
    setSiteId(panel.site?.id ?? null)
    setComments(panel.comments)
    setTagIds(panel.tags.map((t) => t.id))
    setCustomFields(panel.custom_fields ?? {})
    reset()
  }, [panel, reset])

  const sites = useSiteOptions()
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PowerPanelWritePayload = {
        name: name.trim(),
        site_id: siteId ?? "",
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<PowerPanel>(`/api/power-panels/${panel!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<PowerPanel>("/api/power-panels/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["power-panels"] })
      qc.invalidateQueries({ queryKey: ["power-panels-picker"] })
      qc.invalidateQueries({ queryKey: ["power-panel", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
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
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        error={fieldErrors.name}
      />
      <FormCombobox
        label="Site"
        value={siteId}
        onChange={setSiteId}
        options={sites.options.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        placeholder="Select site"
        searchPlaceholder="Search sites…"
        emptyText="No sites."
        error={fieldErrors.site_id}
      />
      <FormTextarea
        label="Comments"
        value={comments}
        onChange={setComments}
        error={fieldErrors.comments}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="powerpanel"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create panel"}
      />
    </form>
  )
}
