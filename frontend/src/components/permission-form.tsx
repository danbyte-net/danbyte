import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ObjectPermission,
  type ObjectPermissionWritePayload,
  type Paginated,
  type RBACAction,
  type RBACGroup,
  type RBACObjectTypes,
  type RBACUser,
  type TenantPicker,
} from "@/lib/api"
import {
  CheckList,
  Field,
  FormCheckbox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
  type CheckOption,
} from "@/components/forms"

const ALL_ACTIONS: RBACAction[] = ["view", "add", "change", "delete"]
const WILDCARD = "*"

export interface PermissionFormProps {
  permission?: ObjectPermission
  onSaved: (p: ObjectPermission) => void
  onCancel: () => void
}

export function PermissionForm({
  permission,
  onSaved,
  onCancel,
}: PermissionFormProps) {
  const isEdit = !!permission
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(permission?.name ?? "")
  const [description, setDescription] = useState(permission?.description ?? "")
  const [enabled, setEnabled] = useState(permission?.enabled ?? true)
  const [allTypes, setAllTypes] = useState(
    permission?.object_types.includes(WILDCARD) ?? false
  )
  const [objectTypes, setObjectTypes] = useState<string[]>(
    permission?.object_types.filter((t) => t !== WILDCARD) ?? []
  )
  const [actions, setActions] = useState<RBACAction[]>(
    permission?.actions ?? ["view"]
  )
  const [groupIds, setGroupIds] = useState<number[]>(
    permission?.groups.map((g) => g.id) ?? []
  )
  const [userIds, setUserIds] = useState<number[]>(
    permission?.users.map((u) => u.id) ?? []
  )
  const [tenantIds, setTenantIds] = useState<string[]>(
    permission?.tenants.map((t) => t.id) ?? []
  )
  const [siteIds, setSiteIds] = useState<string[]>(
    permission?.sites.map((s) => s.id) ?? []
  )
  const [constraintsText, setConstraintsText] = useState(
    permission?.constraints != null
      ? JSON.stringify(permission.constraints, null, 2)
      : ""
  )
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    if (!permission) return
    setName(permission.name)
    setDescription(permission.description)
    setEnabled(permission.enabled)
    setAllTypes(permission.object_types.includes(WILDCARD))
    setObjectTypes(permission.object_types.filter((t) => t !== WILDCARD))
    setActions(permission.actions)
    setGroupIds(permission.groups.map((g) => g.id))
    setUserIds(permission.users.map((u) => u.id))
    setTenantIds(permission.tenants.map((t) => t.id))
    setSiteIds(permission.sites.map((s) => s.id))
    setConstraintsText(
      permission.constraints != null
        ? JSON.stringify(permission.constraints, null, 2)
        : ""
    )
    reset()
  }, [permission, reset])

  const typesQuery = useQuery({
    queryKey: ["rbac", "object-types"],
    queryFn: () => api<RBACObjectTypes>("/api/rbac/object-types/"),
  })
  const groupsQuery = useQuery({
    queryKey: ["groups"],
    queryFn: () => api<Paginated<RBACGroup>>("/api/groups/"),
  })
  const usersQuery = useQuery({
    queryKey: ["users", ""],
    queryFn: () => api<Paginated<RBACUser>>("/api/users/"),
  })
  const tenantsQuery = useQuery({
    queryKey: ["tenants", "picker"],
    queryFn: () => api<Paginated<TenantPicker>>("/api/tenants/?picker=1"),
  })
  const sitesQuery = useQuery({
    queryKey: ["sites", "picker"],
    queryFn: () => api<Paginated<{ id: string; name: string }>>("/api/sites/"),
  })

  const typeOptions = useMemo<CheckOption<string>[]>(
    () =>
      (typesQuery.data?.object_types ?? []).map((t) => ({
        value: t.slug,
        label: t.label,
        hint: t.group,
      })),
    [typesQuery.data]
  )
  const groupOptions: CheckOption<number>[] = (
    groupsQuery.data?.results ?? []
  ).map((g) => ({ value: g.id, label: g.name }))
  const userOptions: CheckOption<number>[] = (
    usersQuery.data?.results ?? []
  ).map((u) => ({ value: u.id, label: u.username }))
  const tenantOptions: CheckOption<string>[] = (
    tenantsQuery.data?.results ?? []
  ).map((t) => ({ value: t.id, label: t.name }))
  const siteOptions: CheckOption<string>[] = (
    sitesQuery.data?.results ?? []
  ).map((s) => ({ value: s.id, label: s.name }))

  const toggleAction = (a: RBACAction) =>
    setActions((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
    )

  const handleAllTypesChange = (checked: boolean) => {
    setAllTypes(checked)
    // Enabling the wildcard clears any specific picks so nothing is silently
    // retained in state and then quietly discarded by the submit payload.
    if (checked) setObjectTypes([])
  }

  const mutation = useMutation({
    mutationFn: async () => {
      let constraints: unknown = null
      const trimmed = constraintsText.trim()
      if (trimmed) {
        try {
          constraints = JSON.parse(trimmed)
        } catch {
          setJsonError("Invalid JSON.")
          throw new Error("Invalid JSON in constraints.")
        }
      }
      setJsonError(null)
      const payload: ObjectPermissionWritePayload = {
        name: name.trim(),
        description: description.trim(),
        enabled,
        object_types: allTypes ? [WILDCARD] : objectTypes,
        actions,
        constraints,
        group_ids: groupIds,
        user_ids: userIds,
        tenant_ids: tenantIds,
        site_ids: siteIds,
      }
      if (isEdit)
        return api<ObjectPermission>(
          `/api/object-permissions/${permission!.id}/`,
          { method: "PATCH", body: JSON.stringify(payload) }
        )
      return api<ObjectPermission>("/api/object-permissions/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["object-permissions"] })
      qc.invalidateQueries({ queryKey: ["object-permission", saved.id] })
      qc.invalidateQueries({ queryKey: ["me"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === "Invalid JSON in constraints.") return
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
      className="grid max-w-2xl gap-4"
    >
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
      <FormCheckbox
        label="Enabled"
        checked={enabled}
        onChange={setEnabled}
        hint="Disabled permissions grant nothing"
      />

      <Field
        label="Actions"
        hint="What this grants on the selected object types"
        error={fieldErrors.actions}
      >
        <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-border p-3">
          {ALL_ACTIONS.map((a) => (
            <FormCheckbox
              key={a}
              label={a}
              checked={actions.includes(a)}
              onChange={() => toggleAction(a)}
            />
          ))}
        </div>
      </Field>

      <Field
        label="Object types"
        hint="The models this permission applies to"
        error={fieldErrors.object_types}
      >
        <FormCheckbox
          label="All object types"
          checked={allTypes}
          onChange={handleAllTypesChange}
          hint="Wildcard — grants on every model"
          className="mb-2"
        />
        {allTypes ? (
          <p className="text-[13px] text-muted-foreground">
            Grants on every model. Enabling this clears any specific object-type
            picks — turn it off to choose individual models again.
          </p>
        ) : (
          <CheckList
            options={typeOptions}
            value={objectTypes}
            onChange={setObjectTypes}
            empty="Loading object types…"
          />
        )}
      </Field>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Groups" hint="Members get this grant">
          <CheckList
            options={groupOptions}
            value={groupIds}
            onChange={setGroupIds}
            empty="No groups yet."
          />
        </Field>
        <Field label="Users" hint="Direct grants (besides groups)">
          <CheckList
            options={userOptions}
            value={userIds}
            onChange={setUserIds}
            empty="No users yet."
          />
        </Field>
      </div>

      <Field
        label="Tenant scope"
        hint="Empty = every tenant the user can access"
      >
        <CheckList
          options={tenantOptions}
          value={tenantIds}
          onChange={setTenantIds}
          empty="No tenants yet."
        />
      </Field>

      <Field
        label="Site scope"
        hint="Empty = all sites. Narrows object types that have a site (devices, prefixes, IPs, racks…); others are unaffected. Tip: pair an edit grant scoped to a site with an unscoped view grant for 'edit own site, see everything'."
      >
        <CheckList
          options={siteOptions}
          value={siteIds}
          onChange={setSiteIds}
          empty="No sites yet."
        />
      </Field>

      <FormTextarea
        label="Constraints (advanced)"
        hint="JSON queryset filter, or a list of filters OR'd together"
        rows={5}
        value={constraintsText}
        onChange={(v) => {
          setConstraintsText(v)
          setJsonError(null)
        }}
        placeholder='e.g. {"status__slug": "active"} or [{"site__slug": "dc-ams"}]'
        error={jsonError ?? fieldErrors.constraints}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create permission"}
      />
    </form>
  )
}
