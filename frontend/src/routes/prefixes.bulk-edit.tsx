import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type BulkUpdateFields,
  type Paginated,
  type SiteOption,
  type StatusOption,
  type TagOption,
  type VLANOption,
  type VRFOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Combobox } from "@/components/ui/combobox"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { EditPageShell } from "@/components/edit-page-shell"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/prefixes/bulk-edit")({
  validateSearch: (s: Record<string, unknown>) => ({
    ids: typeof s.ids === "string" ? s.ids : "",
  }),
  component: BulkEditPrefixesPage,
})

const KEEP = "__keep__"
const NONE = "__none__"

function BulkEditPrefixesPage() {
  const { ids: idsCsv } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  const [statusId, setStatusId] = useState<string>(KEEP)
  const [vrfId, setVrfId] = useState<string>(KEEP)
  const [siteId, setSiteId] = useState<string>(KEEP)
  const [vlanId, setVlanId] = useState<string>(KEEP)
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const statuses = useQuery({
    queryKey: ["prefix-statuses-picker"],
    queryFn: () =>
      api<Paginated<StatusOption>>("/api/statuses/?available_to=prefix"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/"),
    staleTime: 10 * 60_000,
  })
  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const back = () => nav({ to: "/prefixes" })

  const m = useMutation({
    mutationFn: () => {
      const fields: BulkUpdateFields = {}
      if (statusId !== KEEP)
        fields.status_id = statusId === NONE ? null : statusId
      if (vrfId !== KEEP) fields.vrf_id = vrfId === NONE ? null : vrfId
      if (siteId !== KEEP) fields.site_id = siteId === NONE ? null : siteId
      if (vlanId !== KEEP) fields.vlan_id = vlanId === NONE ? null : vlanId
      if (addTags.length) fields.add_tag_ids = addTags
      if (removeTags.length) fields.remove_tag_ids = removeTags
      if (Object.keys(fields).length === 0) {
        throw new Error("Pick at least one field to update.")
      }
      return api<{ updated: number }>("/api/prefixes/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(
        `Updated ${res.updated} prefix${res.updated === 1 ? "" : "es"}.`
      )
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      back()
    },
    onError: (err) => apiErrorToast(err),
  })

  if (ids.length === 0) {
    return (
      <EditPageShell
        crumbs={[
          { label: "Prefixes", to: "/prefixes" },
          { label: "Bulk edit" },
        ]}
        title="Bulk edit"
      >
        <p className="text-sm text-muted-foreground">
          No prefixes selected. Go back to the list and pick rows first.
        </p>
      </EditPageShell>
    )
  }

  return (
    <EditPageShell
      crumbs={[
        { label: "Prefixes", to: "/prefixes" },
        { label: `Bulk edit (${ids.length})` },
      ]}
      title={`Bulk edit ${ids.length} prefix${ids.length === 1 ? "" : "es"}`}
      subtitle="Only fields you change are applied. Tags are merged - add or remove these without disturbing the rest."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          m.mutate()
        }}
        className="grid gap-4"
      >
        <Field label="Status">
          <Combobox
            value={statusId}
            onChange={(v) => setStatusId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "- none -" },
              ...(statuses.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
                color: s.color,
                badge: true,
              })),
            ]}
            searchPlaceholder="Search statuses…"
            emptyText="No matches."
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="VRF">
            <Combobox
              value={vrfId}
              onChange={(v) => setVrfId(v ?? KEEP)}
              options={[
                { value: KEEP, label: "(keep)" },
                { value: NONE, label: "Global" },
                ...(vrfs.data?.results ?? []).map((v) => ({
                  value: v.id,
                  label: v.name,
                  color: v.color,
                  badge: true,
                })),
              ]}
              searchPlaceholder="Search VRFs…"
              emptyText="No matches."
            />
          </Field>
          <Field label="Site">
            <Combobox
              value={siteId}
              onChange={(v) => setSiteId(v ?? KEEP)}
              options={[
                { value: KEEP, label: "(keep)" },
                { value: NONE, label: "No site" },
                ...(sites.data?.results ?? []).map((s) => ({
                  value: s.id,
                  label: s.name,
                })),
              ]}
              searchPlaceholder="Search sites…"
              emptyText="No matches."
            />
          </Field>
        </div>

        <Field label="VLAN">
          <Combobox
            value={vlanId}
            onChange={(v) => setVlanId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "No VLAN" },
              ...(vlans.data?.results ?? []).map((v) => ({
                value: v.id,
                label: `${v.vlan_id} · ${v.name}`,
              })),
            ]}
            searchPlaceholder="Search VLANs…"
            emptyText="No matches."
          />
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
