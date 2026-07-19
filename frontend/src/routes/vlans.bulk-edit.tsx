import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type SiteOption,
  type TagOption,
  type VLANBulkUpdateFields,
  type ZoneOption,
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

export const Route = createFileRoute("/vlans/bulk-edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
  component: BulkEditVlansPage,
})

const KEEP = "__keep__"
const NONE = "__none__"

function BulkEditVlansPage() {
  const { ids: idsCsv } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  const [siteId, setSiteId] = useState<string>(KEEP)
  const [zoneId, setZoneId] = useState<string>(KEEP)
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/"),
    staleTime: 10 * 60_000,
  })
  const zones = useQuery({
    queryKey: ["zones-picker"],
    queryFn: () => api<Paginated<ZoneOption>>("/api/zones/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const back = () => nav({ to: "/vlans" })

  const m = useMutation({
    mutationFn: () => {
      const fields: VLANBulkUpdateFields = {}
      if (siteId !== KEEP) fields.site_id = siteId === NONE ? null : siteId
      if (zoneId !== KEEP) fields.zone_id = zoneId === NONE ? null : zoneId
      if (addTags.length) fields.add_tag_ids = addTags
      if (removeTags.length) fields.remove_tag_ids = removeTags
      if (Object.keys(fields).length === 0) {
        throw new Error("Pick at least one field to update.")
      }
      return api<{ updated: number }>("/api/vlans/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(
        `Updated ${res.updated} VLAN${res.updated === 1 ? "" : "s"}.`
      )
      qc.invalidateQueries({ queryKey: ["vlans"] })
      qc.invalidateQueries({ queryKey: ["vlans-picker"] })
      back()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (ids.length === 0) {
    return (
      <EditPageShell
        crumbs={[{ label: "VLANs", to: "/vlans" }, { label: "Bulk edit" }]}
        title="Bulk edit"
      >
        <p className="text-sm text-muted-foreground">
          No VLANs selected. Go back to the list and pick rows first.
        </p>
      </EditPageShell>
    )
  }

  return (
    <EditPageShell
      crumbs={[
        { label: "VLANs", to: "/vlans" },
        { label: `Bulk edit (${ids.length})` },
      ]}
      title={`Bulk edit ${ids.length} VLAN${ids.length === 1 ? "" : "s"}`}
      subtitle="Only fields you change are applied. Tags are merged."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="grid gap-4"
      >
        <Field label="Site">
          <Select value={siteId} onValueChange={setSiteId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>(keep)</SelectItem>
              <SelectItem value={NONE}>No site</SelectItem>
              {sites.data?.results.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Zone">
          <Select value={zoneId} onValueChange={setZoneId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={KEEP}>(keep)</SelectItem>
              <SelectItem value={NONE}>No zone</SelectItem>
              {zones.data?.results.map((z) => (
                <SelectItem key={z.id} value={z.id}>
                  {z.name}
                </SelectItem>
              ))}
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
