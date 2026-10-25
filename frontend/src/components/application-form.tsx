import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiAll } from "@/lib/api-all"
import type { Application, ManufacturerOption } from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ApplicationPicker } from "@/components/application-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

// Create / edit an application (#436). The parent nests it into a
// domain → process → application tree; the server refuses a cycle.

export interface ApplicationFormProps {
  application?: Application
  onSaved: (a: Application) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function ApplicationForm({
  application: app,
  onSaved,
  onCancel,
}: ApplicationFormProps) {
  const isEdit = !!app
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(app?.name ?? "")
  const [slug, setSlug] = useState(app?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [parentId, setParentId] = useState<string | null>(
    app?.parent?.id ?? null
  )
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    app?.manufacturer?.id ?? null
  )
  const [description, setDescription] = useState(app?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    app?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    app?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!app) return
    setName(app.name)
    setSlug(app.slug)
    setSlugDirty(true)
    setParentId(app.parent?.id ?? null)
    setManufacturerId(app.manufacturer?.id ?? null)
    setDescription(app.description)
    setTagIds(app.tags?.map((t) => t.id) ?? [])
    setCustomFields(app.custom_fields ?? {})
    reset()
  }, [app, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () => apiAll<ManufacturerOption>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: () =>
      saveObject<Application>({
        objectType: "api.application",
        endpoint: "/api/applications/",
        id: isEdit ? app!.id : undefined,
        payload: {
          name: name.trim(),
          slug: slug.trim() || slugify(name),
          parent_id: parentId,
          manufacturer_id: manufacturerId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        },
      }),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["applications"] })
      qc.invalidateQueries({ queryKey: ["applications-picker"] })
      qc.invalidateQueries({ queryKey: ["application", saved.id] })
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
      <FormSection title="Application" card>
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
            placeholder="PostgreSQL"
            error={fieldErrors.name}
          />
          <FormText
            label="Slug"
            hint="URL-safe id"
            placeholder="postgresql"
            value={slug}
            onChange={(v) => {
              setSlugDirty(true)
              setSlug(slugify(v))
            }}
            mono
            error={fieldErrors.slug}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <ApplicationPicker
            label="Parent"
            hint="optional"
            value={parentId}
            onChange={setParentId}
            noneLabel="No parent"
            excludeIds={app ? [app.id] : undefined}
            error={fieldErrors.parent_id}
          />
          <FormCombobox
            label="Manufacturer"
            hint="optional"
            value={manufacturerId}
            onChange={setManufacturerId}
            options={(manufacturers.data?.results ?? []).map((m) => ({
              value: m.id,
              label: m.name,
            }))}
            noneLabel="No manufacturer"
            placeholder="Select a manufacturer…"
            searchPlaceholder="Search manufacturers…"
            emptyText="No manufacturers."
            error={fieldErrors.manufacturer_id}
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
        model="application"
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
        submitLabel={isEdit ? "Save changes" : "Create application"}
      />
    </form>
  )
}
