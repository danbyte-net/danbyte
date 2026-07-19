import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useQuery } from "@tanstack/react-query"

import {
  api,
  type Paginated,
  type RBACGroup,
  type RBACGroupWritePayload,
  type SiteOption,
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
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useMe } from "@/lib/use-me"

export interface GroupFormProps {
  group?: RBACGroup
  onSaved: (g: RBACGroup) => void
  onCancel: () => void
}

export function GroupForm({ group, onSaved, onCancel }: GroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(group?.name ?? "")
  const [description, setDescription] = useState(group?.description ?? "")

  const { siteSeparation } = useMe()
  const [siteScoped, setSiteScoped] = useState(siteSeparation)
  const [siteRoleSites, setSiteRoleSites] = useState<string[]>([])
  const [siteRole, setSiteRole] = useState<"editor" | "viewer">("editor")
  const [siteSilo, setSiteSilo] = useState(false)

  const sitesQuery = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/?picker=1"),
    enabled: !isEdit,
  })
  const siteOptions: CheckOption<string>[] = (
    sitesQuery.data?.results ?? []
  ).map((s) => ({ value: s.id, label: s.name }))

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setDescription(group.description)
    reset()
  }, [group, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RBACGroupWritePayload = {
        name: name.trim(),
        set_description: description.trim(),
      }
      if (!isEdit && siteScoped && siteRoleSites.length > 0) {
        payload.site_role = {
          role: siteRole,
          site_ids: siteRoleSites,
          ...(siteRole === "editor" && siteSilo ? { silo: true } : {}),
        }
      }
      if (isEdit)
        return api<RBACGroup>(`/api/groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RBACGroup>("/api/groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["groups"] })
      qc.invalidateQueries({ queryKey: ["group", saved.id] })
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
        if (!isEdit && siteScoped && siteRoleSites.length === 0) {
          toast.error("Pick at least one site, or untick site-scoped access.")
          return
        }
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
        hint={group?.built_in ? "Built-in group" : undefined}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.set_description}
      />

      {!isEdit && (
        <div className="grid gap-3 rounded-md border border-border p-3">
          <FormCheckbox
            label="Site-scoped access (local IT)"
            checked={siteScoped}
            onChange={setSiteScoped}
            hint="Everyone in this group becomes a site editor/viewer for the chosen sites."
          />
          {siteScoped && (
            <div className="grid gap-3 pl-1">
              <SegmentedTabs
                items={[
                  { value: "editor", label: "Editor (add/edit/delete)" },
                  { value: "viewer", label: "Viewer (read only)" },
                ]}
                value={siteRole}
                onValueChange={(v) => setSiteRole(v as "editor" | "viewer")}
              />
              <Field
                label="Sites"
                hint="Members can only add/edit/delete objects in these sites"
              >
                <CheckList
                  options={siteOptions}
                  value={siteRoleSites}
                  onChange={setSiteRoleSites}
                  empty="No sites yet."
                />
              </Field>
              {siteRole === "editor" && (
                <FormCheckbox
                  label="Can only see their own sites"
                  checked={siteSilo}
                  onChange={setSiteSilo}
                  hint="Off (default) = read everything, edit only their sites. On = a strict silo."
                />
              )}
            </div>
          )}
        </div>
      )}

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
