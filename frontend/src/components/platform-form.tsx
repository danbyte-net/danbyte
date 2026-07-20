import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ExportTemplate,
  type ManufacturerOption,
  type Paginated,
  type Platform,
  type PlatformGroupOption,
  type PlatformWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  QuickAddDialog,
  useFieldErrors,
} from "@/components/forms"
import {
  LifecycleFormSection,
  lifecycleFormValue,
  lifecyclePayload,
} from "@/components/lifecycle-fields"

export interface PlatformFormProps {
  platform?: Platform
  onSaved: (p: Platform) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function PlatformForm({
  platform,
  onSaved,
  onCancel,
}: PlatformFormProps) {
  const isEdit = !!platform
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(platform?.name ?? "")
  const [slug, setSlug] = useState(platform?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [groupId, setGroupId] = useState<string | null>(
    platform?.group?.id ?? null
  )
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    platform?.manufacturer?.id ?? null
  )
  const [configTemplateId, setConfigTemplateId] = useState<string | null>(
    platform?.config_template?.id ?? null
  )
  const [description, setDescription] = useState(platform?.description ?? "")
  const [lifecycle, setLifecycle] = useState(lifecycleFormValue(platform))

  useEffect(() => {
    if (!platform) return
    setName(platform.name)
    setSlug(platform.slug)
    setSlugDirty(true)
    setGroupId(platform.group?.id ?? null)
    setManufacturerId(platform.manufacturer?.id ?? null)
    setConfigTemplateId(platform.config_template?.id ?? null)
    setDescription(platform.description)
    setLifecycle(lifecycleFormValue(platform))
    reset()
  }, [platform, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const groups = useQuery({
    queryKey: ["platform-groups-picker"],
    queryFn: () =>
      api<Paginated<PlatformGroupOption>>("/api/platform-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        "/api/export-templates/?object_type=device"
      ),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PlatformWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        group_id: groupId,
        manufacturer_id: manufacturerId,
        config_template_id: configTemplateId,
        description: description.trim(),
        ...lifecyclePayload(lifecycle),
      }
      if (isEdit)
        return api<Platform>(`/api/platforms/${platform!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Platform>("/api/platforms/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["platforms"] })
      qc.invalidateQueries({ queryKey: ["platforms-picker"] })
      qc.invalidateQueries({ queryKey: ["platform", saved.id] })
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
        onChange={onNameChange}
        placeholder="Cisco IOS-XE 17"
        error={fieldErrors.name}
      />
      <FormText
        label="Slug"
        hint="URL-safe id"
        required
        placeholder="cisco-ios-xe-17"
        value={slug}
        onChange={(v) => {
          setSlugDirty(true)
          setSlug(slugify(v))
        }}
        mono
        error={fieldErrors.slug}
      />
      <FormCombobox
        label="Group"
        hint="optional"
        value={groupId}
        onChange={setGroupId}
        options={(groups.data?.results ?? []).map((g) => ({
          value: g.id,
          label: g.name,
        }))}
        noneLabel="No group"
        placeholder="Select a group…"
        searchPlaceholder="Search groups…"
        emptyText="No platform groups."
        error={fieldErrors.group_id}
        quickAdd={
          <QuickAddDialog
            title="New platform group"
            endpoint="/api/platform-groups/"
            fields={[{ name: "name", label: "Name", required: true }]}
            onCreated={(g) => {
              qc.invalidateQueries({ queryKey: ["platform-groups-picker"] })
              qc.invalidateQueries({ queryKey: ["platform-groups"] })
              setGroupId(g.id)
            }}
          />
        }
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
        quickAdd={
          <QuickAddDialog
            title="New manufacturer"
            endpoint="/api/manufacturers/"
            fields={[{ name: "name", label: "Name", required: true }]}
            onCreated={(m) => {
              qc.invalidateQueries({ queryKey: ["manufacturers-picker"] })
              setManufacturerId(m.id)
            }}
          />
        }
      />
      <FormCombobox
        label="Config template"
        hint="optional"
        value={configTemplateId}
        onChange={setConfigTemplateId}
        options={(templates.data?.results ?? []).map((t) => ({
          value: t.id,
          label: t.name,
        }))}
        noneLabel="No config template"
        placeholder="Select a template…"
        searchPlaceholder="Search templates…"
        emptyText="No device export templates."
        error={fieldErrors.config_template_id}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <LifecycleFormSection
        value={lifecycle}
        onChange={setLifecycle}
        errors={fieldErrors}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create platform"}
      />
    </form>
  )
}
