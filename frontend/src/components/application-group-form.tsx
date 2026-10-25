import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { ApplicationGroup } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

// Create / edit an application group (#436). Its applications are kept on
// the group page's Applications tab, where each change reaches the hosts.

export interface ApplicationGroupFormProps {
  group?: ApplicationGroup
  onSaved: (g: ApplicationGroup) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function ApplicationGroupForm({
  group,
  onSaved,
  onCancel,
}: ApplicationGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(group?.name ?? "")
  const [slug, setSlug] = useState(group?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [description, setDescription] = useState(group?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    group?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    group?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setSlug(group.slug)
    setSlugDirty(true)
    setDescription(group.description)
    setTagIds(group.tags.map((t) => t.id))
    setCustomFields(group.custom_fields)
    reset()
  }, [group, reset])

  const mutation = useMutation({
    mutationFn: () =>
      saveObject<ApplicationGroup>({
        objectType: "api.applicationgroup",
        endpoint: "/api/application-groups/",
        id: group?.id,
        payload: {
          name: name.trim(),
          slug: slug.trim() || slugify(name),
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        },
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["application-groups"] })
      qc.invalidateQueries({ queryKey: ["application-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["application-group", saved.id] })
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
      <FormSection title="Application group" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={(v) => {
              setName(v)
              if (!slugDirty) setSlug(slugify(v))
            }}
            placeholder="RDS"
            error={fieldErrors.name}
          />
          <FormText
            label="Slug"
            hint="URL-safe id"
            placeholder="rds"
            value={slug}
            onChange={(v) => {
              setSlugDirty(true)
              setSlug(slugify(v))
            }}
            mono
            error={fieldErrors.slug}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>
      <CustomFieldInputs
        model="applicationgroup"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
