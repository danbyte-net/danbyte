import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ConfigBundle,
  ConfigBundleWritePayload,
  DeviceRoleOption,
  ExportTemplate,
  Paginated,
} from "@/lib/api"
import {
  Field,
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import type { IdOption } from "@/components/cells/id-multi-select"
import { useSaveObject } from "@/lib/save-object"

export interface ConfigBundleFormProps {
  bundle?: ConfigBundle
  onSaved: (v: ConfigBundle) => void
  onCancel: () => void
}

export function ConfigBundleForm({
  bundle,
  onSaved,
  onCancel,
}: ConfigBundleFormProps) {
  const isEdit = !!bundle
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(bundle?.name ?? "")
  const [description, setDescription] = useState(bundle?.description ?? "")
  const [templateIds, setTemplateIds] = useState<string[]>(
    bundle?.templates.map((t) => t.id) ?? []
  )
  const [roleIds, setRoleIds] = useState<string[]>(
    bundle?.roles.map((r) => r.id) ?? []
  )

  useEffect(() => {
    if (!bundle) return
    setName(bundle.name)
    setDescription(bundle.description)
    setTemplateIds(bundle.templates.map((t) => t.id))
    setRoleIds(bundle.roles.map((r) => r.id))
    reset()
  }, [bundle, reset])

  // Only device templates can land in a bundle - the backend refuses any
  // other object type, so the picker never offers one.
  const templates = useQuery({
    queryKey: ["export-templates", "device"],
    queryFn: () =>
      api<Paginated<ExportTemplate>>(
        "/api/export-templates/?object_type=device"
      ),
    staleTime: 5 * 60_000,
  })
  const templateOptions = useMemo<IdOption[]>(
    () =>
      (templates.data?.results ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        hint: t.bundle_path,
      })),
    [templates.data]
  )

  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<DeviceRoleOption>>("/api/device-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const roleOptions = useMemo<IdOption[]>(
    () => (roles.data?.results ?? []).map((r) => ({ id: r.id, name: r.name })),
    [roles.data]
  )

  const save = useMutation({
    mutationFn: () => {
      const payload: ConfigBundleWritePayload = {
        name: name.trim(),
        description: description.trim(),
        template_ids: templateIds,
        role_ids: roleIds,
      }
      return saveObject<ConfigBundle>({
        objectType: "api.configbundle",
        endpoint: "/api/config-bundles/",
        id: isEdit ? bundle.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["config-bundles"] })
      qc.invalidateQueries({ queryKey: ["config-bundle", saved.id] })
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
        save.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Bundle" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Files" card>
        <Field
          label="Templates"
          info="Device export templates rendered together. Each lands at its target path."
          error={fieldErrors.template_ids}
        >
          <IdMultiSelect
            options={templateOptions}
            value={templateIds}
            onChange={setTemplateIds}
            placeholder="Add template…"
            searchPlaceholder="Search templates…"
            emptyText={
              templates.isLoading ? "Loading…" : "No device templates."
            }
          />
        </Field>
      </FormSection>

      <FormSection title="Roles" card>
        <Field
          label="Device roles"
          info="A device renders its role's bundle with bundle=role."
          error={fieldErrors.role_ids}
        >
          <IdMultiSelect
            options={roleOptions}
            value={roleIds}
            onChange={setRoleIds}
            placeholder="Add role…"
            searchPlaceholder="Search roles…"
            emptyText={roles.isLoading ? "Loading…" : "No device roles."}
          />
        </Field>
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save changes" : "Create bundle"}
      />
    </form>
  )
}
