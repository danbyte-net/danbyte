import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, Script } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SettingsCard } from "@/components/settings/settings-card"
import { Field } from "@/components/forms/field"
import { FormSelect } from "@/components/forms/select"
import { CheckList } from "@/components/forms/check-list"

interface Named {
  id: string
  username?: string
  name?: string
}

/** Who else can see and run this script. */
export function ScriptSharingPanel({
  script,
  canEdit,
}: {
  script: Script
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const [visibility, setVisibility] = useState(script.visibility)
  const [users, setUsers] = useState<string[]>(script.shared_users)
  const [groups, setGroups] = useState<string[]>(script.shared_groups)

  const people = useQuery({
    queryKey: ["rbac-users"],
    queryFn: () => api<Paginated<Named>>("/api/users/"),
    enabled: visibility === "users",
  })
  const teams = useQuery({
    queryKey: ["rbac-groups"],
    queryFn: () => api<Paginated<Named>>("/api/groups/"),
    enabled: visibility === "groups",
  })

  const save = useMutation({
    mutationFn: () =>
      api<Script>(`/api/scripts/${script.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          visibility,
          shared_users: visibility === "users" ? users : [],
          shared_groups: visibility === "groups" ? groups : [],
        }),
      }),
    onSuccess: () => {
      toast.success("Sharing updated")
      void qc.invalidateQueries({ queryKey: ["script", script.id] })
      void qc.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Sharing"
      description="Everyone here still needs permission to view scripts; sharing only decides which ones."
      onSave={canEdit ? () => save.mutate() : undefined}
      saving={save.isPending}
      dirty
    >
      <FormSelect
        label="Who can see it"
        value={visibility}
        onChange={(v) => setVisibility((v ?? "owner") as Script["visibility"])}
        options={[
          { value: "owner", label: "Only me" },
          { value: "users", label: "Chosen users" },
          { value: "groups", label: "Chosen groups" },
          { value: "global", label: "Everyone in the tenant" },
        ]}
        disabled={!canEdit}
      />
      {visibility === "users" && (
        <Field label="Users">
          <CheckList
            options={(people.data?.results ?? []).map((u) => ({
              value: u.id,
              label: u.username ?? u.id,
            }))}
            value={users}
            onChange={setUsers}
            empty="No other accounts."
          />
        </Field>
      )}
      {visibility === "groups" && (
        <Field label="Groups">
          <CheckList
            options={(teams.data?.results ?? []).map((g) => ({
              value: g.id,
              label: g.name ?? g.id,
            }))}
            value={groups}
            onChange={setGroups}
            empty="No groups yet."
          />
        </Field>
      )}
      {visibility === "global" && (
        <p className="text-xs text-muted-foreground">
          Publishing to everyone needs the publish permission; without it the
          save is refused.
        </p>
      )}
    </SettingsCard>
  )
}
