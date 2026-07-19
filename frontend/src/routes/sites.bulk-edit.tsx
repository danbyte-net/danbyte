import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type SiteBulkUpdateFields,
  type SiteGatewayPolicy,
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

export const Route = createFileRoute("/sites/bulk-edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
  component: BulkEditSitesPage,
})

const KEEP = "__keep__"

function BulkEditSitesPage() {
  const { ids: idsCsv } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  const [policy, setPolicy] = useState<string>(KEEP)
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const back = () => nav({ to: "/sites" })

  const m = useMutation({
    mutationFn: () => {
      const fields: SiteBulkUpdateFields = {}
      if (policy !== KEEP) fields.gateway_policy = policy as SiteGatewayPolicy
      if (addTags.length) fields.add_tag_ids = addTags
      if (removeTags.length) fields.remove_tag_ids = removeTags
      if (Object.keys(fields).length === 0) {
        throw new Error("Pick at least one field to update.")
      }
      return api<{ updated: number }>("/api/sites/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(
        `Updated ${res.updated} site${res.updated === 1 ? "" : "s"}.`
      )
      qc.invalidateQueries({ queryKey: ["sites"] })
      qc.invalidateQueries({ queryKey: ["sites-picker"] })
      back()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (ids.length === 0) {
    return (
      <EditPageShell
        crumbs={[{ label: "Sites", to: "/sites" }, { label: "Bulk edit" }]}
        title="Bulk edit"
      >
        <p className="text-sm text-muted-foreground">
          No sites selected. Go back to the list and pick rows first.
        </p>
      </EditPageShell>
    )
  }

  return (
    <EditPageShell
      crumbs={[
        { label: "Sites", to: "/sites" },
        { label: `Bulk edit (${ids.length})` },
      ]}
      title={`Bulk edit ${ids.length} site${ids.length === 1 ? "" : "s"}`}
      subtitle="Only fields you change are applied. Tags are merged."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="grid gap-4"
      >
        <Field label="Gateway policy">
          <Select value={policy} onValueChange={setPolicy}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>(keep)</SelectItem>
              <SelectItem value="first">First usable address</SelectItem>
              <SelectItem value="last">Last usable address</SelectItem>
              <SelectItem value="none">No automatic gateway</SelectItem>
            </SelectContent>
          </Select>
        </Field>
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
