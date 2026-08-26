import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import { type PowerPanel, type PowerPanelWritePayload } from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

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
  const saveObject = useSaveObject()

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

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PowerPanelWritePayload = {
        name: name.trim(),
        site_id: siteId ?? "",
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<PowerPanel>({
        objectType: "api.powerpanel",
        endpoint: "/api/power-panels/",
        id: isEdit ? panel!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormSection title="Power panel" card>
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
          required
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
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Comments"
          value={comments}
          onChange={setComments}
          error={fieldErrors.comments}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
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
