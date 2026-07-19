import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type Tenant,
  type TenantGroup,
  type TenantWritePayload,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  FormCheckbox,
  FormColor,
  FormCombobox,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface TenantFormProps {
  tenant?: Tenant
  onSaved: (saved: Tenant) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function TenantForm({ tenant, onSaved, onCancel }: TenantFormProps) {
  const isEdit = !!tenant
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(tenant?.name ?? "")
  const [slug, setSlug] = useState(tenant?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [color, setColor] = useState(tenant?.color ?? "")
  const [description, setDescription] = useState(tenant?.description ?? "")
  const [isActive, setIsActive] = useState(tenant?.is_active ?? true)
  const [groupId, setGroupId] = useState<string | null>(
    tenant?.group?.id ?? null
  )

  const groupsQuery = useQuery({
    queryKey: ["tenant-groups"],
    queryFn: () => api<Paginated<TenantGroup>>("/api/tenant-groups/"),
  })

  useEffect(() => {
    if (!tenant) return
    setName(tenant.name)
    setSlug(tenant.slug)
    setSlugDirty(true)
    setColor(tenant.color)
    setDescription(tenant.description)
    setIsActive(tenant.is_active)
    setGroupId(tenant.group?.id ?? null)
    reset()
  }, [tenant, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: TenantWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        color: color.trim(),
        description: description.trim(),
        is_active: isActive,
        group_id: groupId,
      }
      if (isEdit)
        return api<Tenant>(`/api/tenants/${tenant!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Tenant>("/api/tenants/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["tenants"] })
      qc.invalidateQueries({ queryKey: ["tenants-picker"] })
      qc.invalidateQueries({ queryKey: ["tenant", saved.id] })
      qc.invalidateQueries({ queryKey: ["tenant-groups"] })
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
        placeholder="Acme Corp"
        value={name}
        onChange={onNameChange}
        error={fieldErrors.name}
      />

      <FormRow>
        <FormText
          label="Slug"
          hint="URL-safe id"
          required
          placeholder="acme"
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
          hint="pick or paste hex"
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
        />
      </FormRow>

      <FormCombobox
        label="Group"
        hint="optional"
        value={groupId}
        onChange={setGroupId}
        options={(groupsQuery.data?.results ?? []).map((g: TenantGroup) => ({
          value: g.id,
          label: g.name,
        }))}
        noneLabel="No group"
        placeholder="No group"
        error={fieldErrors.group_id}
      />

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="e.g. Acme's network records"
        error={fieldErrors.description}
      />

      <FormCheckbox
        checked={isActive}
        onChange={setIsActive}
        label={
          <>
            Active{" "}
            <span className="text-muted-foreground">
              (inactive tenants can't be switched into)
            </span>
          </>
        }
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create Tenant"}
        </Button>
      </div>
    </form>
  )
}
