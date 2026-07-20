import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeviceRole,
  DeviceRoleWritePayload,
  ExportTemplate,
  Paginated,
} from "@/lib/api"
import {
  FormColor,
  FormCombobox,
  FormCheckbox,
  FormFooter,
  FormRow,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

export interface DeviceRoleFormProps {
  role?: DeviceRole
  onSaved: (r: DeviceRole) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function DeviceRoleForm({
  role,
  onSaved,
  onCancel,
}: DeviceRoleFormProps) {
  const isEdit = !!role
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(role?.name ?? "")
  const [slug, setSlug] = useState(role?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [color, setColor] = useState(role?.color ?? "")
  const [configTemplateId, setConfigTemplateId] = useState<string | null>(
    role?.config_template?.id ?? null
  )
  const [description, setDescription] = useState(role?.description ?? "")
  const [isPatchPanel, setIsPatchPanel] = useState(
    role?.is_patch_panel ?? false
  )
  const [hasFov, setHasFov] = useState(role?.has_fov ?? false)
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    role?.custom_fields ?? {}
  )
  const [tagIds, setTagIds] = useState<number[]>(
    role?.tags?.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!role) return
    setName(role.name)
    setSlug(role.slug)
    setSlugDirty(true)
    setColor(role.color)
    setIsPatchPanel(role.is_patch_panel)
    setHasFov(role.has_fov)
    setConfigTemplateId(role.config_template?.id ?? null)
    setDescription(role.description)
    setCustomFields(role.custom_fields)
    setTagIds(role.tags?.map((t) => t.id) ?? [])
    reset()
  }, [role, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

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
      const payload: DeviceRoleWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        color: color || "",
        is_patch_panel: isPatchPanel,
        has_fov: hasFov,
        config_template_id: configTemplateId,
        description: description.trim(),
        custom_fields: customFields,
        tag_ids: tagIds,
      }
      if (isEdit)
        return api<DeviceRole>(`/api/device-roles/${role.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<DeviceRole>("/api/device-roles/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-roles"] })
      qc.invalidateQueries({ queryKey: ["device-roles-picker"] })
      qc.invalidateQueries({ queryKey: ["device-role", saved.id] })
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
        placeholder="Core switch"
        error={fieldErrors.name}
      />
      <FormRow>
        <FormText
          label="Slug"
          hint="URL-safe id"
          required
          placeholder="core-switch"
          value={slug}
          onChange={(v) => {
            setSlugDirty(true)
            setSlug(slugify(v))
          }}
          mono
          error={fieldErrors.slug}
        />
        <FormColor
          label="Color"
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
        />
      </FormRow>
      <FormCheckbox
        label="Patch-panel role"
        hint="Devices with this role are passive patch panels — hidden in the topology map by default and kept out of the level tiers."
        checked={isPatchPanel}
        onChange={setIsPatchPanel}
      />
      <FormCheckbox
        label="Camera field of view"
        hint="Floor-plan tiles typed by this role get a direction / angle / reach cone (e.g. a CCTV role)."
        checked={hasFov}
        onChange={setHasFov}
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
      <CustomFieldInputs
        model="devicerole"
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
        submitLabel={isEdit ? "Save changes" : "Create role"}
      />
    </form>
  )
}
