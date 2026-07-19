import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPBulkUpdateFields,
  type IPRoleOption,
  type StatusOption,
  type Paginated,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { EditPageShell } from "@/components/edit-page-shell"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/ips/bulk-edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    ids: typeof s.ids === "string" ? s.ids : "",
    returnTo: typeof s.returnTo === "string" ? s.returnTo : undefined,
  }),
  component: BulkEditIpsPage,
})

const KEEP = "__keep__"
const NONE = "__none__"

function BulkEditIpsPage() {
  const { ids: idsCsv, returnTo } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  const [statusId, setStatusId] = useState<string>(KEEP)
  const [roleId, setRoleId] = useState<string>(KEEP)
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const statuses = useQuery({
    queryKey: ["statuses-picker"],
    queryFn: () => api<Paginated<StatusOption>>("/api/statuses/"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["ip-roles-picker"],
    queryFn: () => api<Paginated<IPRoleOption>>("/api/ip-roles/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const back = () => {
    if (returnTo) nav({ to: returnTo })
    else nav({ to: "/prefixes" })
  }

  const m = useMutation({
    mutationFn: () => {
      const fields: IPBulkUpdateFields = {}
      if (statusId !== KEEP)
        fields.status_id = statusId === NONE ? null : statusId
      if (roleId !== KEEP) fields.role_id = roleId === NONE ? null : roleId
      if (addTags.length) fields.add_tag_ids = addTags
      if (removeTags.length) fields.remove_tag_ids = removeTags
      if (Object.keys(fields).length === 0) {
        throw new Error("Pick at least one field to update.")
      }
      return api<{ updated: number }>("/api/ips/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(`Updated ${res.updated} IP${res.updated === 1 ? "" : "s"}.`)
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["ips"] })
      back()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (ids.length === 0) {
    return (
      <EditPageShell
        crumbs={[
          { label: "Prefixes", to: "/prefixes" },
          { label: "Bulk edit IPs" },
        ]}
        title="Bulk edit"
      >
        <p className="text-sm text-muted-foreground">
          No IPs selected. Go back to the list and pick rows first.
        </p>
      </EditPageShell>
    )
  }

  return (
    <EditPageShell
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        { label: `Bulk edit IPs (${ids.length})` },
      ]}
      title={`Bulk edit ${ids.length} IP${ids.length === 1 ? "" : "s"}`}
      subtitle="Only fields you change are applied. Tags are merged."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="grid gap-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <Select value={statusId} onValueChange={setStatusId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>(keep)</SelectItem>
                <SelectItem value={NONE}>— none —</SelectItem>
                {statuses.data?.results.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Role">
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>(keep)</SelectItem>
                <SelectItem value={NONE}>No role</SelectItem>
                {roles.data?.results.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field label="Add tags">
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={addTags}
            onChange={setAddTags}
            placeholder="Tags to add…"
          />
        </Field>
        <Field label="Remove tags">
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={removeTags}
            onChange={setRemoveTags}
            placeholder="Tags to remove…"
          />
        </Field>

        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={back}
            disabled={m.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={m.isPending}>
            {m.isPending ? "Applying…" : `Apply to ${ids.length}`}
          </Button>
        </div>
      </form>
    </EditPageShell>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  )
}
