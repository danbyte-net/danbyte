import { useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  SiteOption,
  StatusOption,
  TagOption,
  VLANBulkUpdateFields,
  VLANGroupOption,
  VRFOption,
  ZoneOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Combobox } from "@/components/ui/combobox"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { FieldEditor, useFieldEditorOptions } from "@/components/forms"
import type { BulkFieldSpec } from "@/components/forms"
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
// The endpoint also takes a group move (#176).
type BulkFields = VLANBulkUpdateFields & { group_id?: string | null }
const DESCRIPTION: BulkFieldSpec[] = [
  { key: "description", label: "Description", kind: "text" },
]

function BulkEditVlansPage() {
  const { ids: idsCsv } = Route.useSearch()
  const ids = idsCsv.split(",").filter(Boolean)
  const nav = useNavigate()
  const qc = useQueryClient()

  const [statusId, setStatusId] = useState<string>(KEEP)
  const [siteId, setSiteId] = useState<string>(KEEP)
  const [groupId, setGroupId] = useState<string>(KEEP)
  const [zoneId, setZoneId] = useState<string>(KEEP)
  const [vrfId, setVrfId] = useState<string>(KEEP)
  // undefined = keep; a string (even "") is written to every row.
  const [description, setDescription] = useState<string | undefined>()
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const statuses = useQuery({
    queryKey: ["statuses", "vlan"],
    queryFn: () =>
      api<Paginated<StatusOption>>("/api/statuses/?available_to=vlan&picker=1"),
    staleTime: 5 * 60_000,
  })
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () => api<Paginated<SiteOption>>("/api/sites/"),
    staleTime: 10 * 60_000,
  })
  const groups = useQuery({
    queryKey: ["vlan-groups-picker"],
    queryFn: () =>
      api<Paginated<VLANGroupOption>>("/api/vlan-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const zones = useQuery({
    queryKey: ["zones-picker"],
    queryFn: () => api<Paginated<ZoneOption>>("/api/zones/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const editorOptions = useFieldEditorOptions(DESCRIPTION)

  const back = () => nav({ to: "/vlans" })

  const m = useMutation({
    mutationFn: () => {
      const fields: BulkFields = {}
      if (statusId !== KEEP)
        fields.status_id = statusId === NONE ? null : statusId
      if (siteId !== KEEP) fields.site_id = siteId === NONE ? null : siteId
      if (groupId !== KEEP) fields.group_id = groupId === NONE ? null : groupId
      if (zoneId !== KEEP) fields.zone_id = zoneId === NONE ? null : zoneId
      if (vrfId !== KEEP) fields.vrf_id = vrfId === NONE ? null : vrfId
      if (description !== undefined) fields.description = description
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
        <Field label="Status">
          <Combobox
            value={statusId}
            onChange={(v) => setStatusId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "No status" },
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
        <Field label="Group">
          <Combobox
            value={groupId}
            onChange={(v) => setGroupId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "No group" },
              ...(groups.data?.results ?? []).map((g) => ({
                value: g.id,
                label: g.name,
                hint: `${g.min_vid}–${g.max_vid}`,
              })),
            ]}
            searchPlaceholder="Search groups…"
            emptyText="No matches."
          />
        </Field>
        <Field label="Zone">
          <Combobox
            value={zoneId}
            onChange={(v) => setZoneId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "No zone" },
              ...(zones.data?.results ?? []).map((z) => ({
                value: z.id,
                label: z.name,
                color: z.color,
                badge: true,
              })),
            ]}
            searchPlaceholder="Search zones…"
            emptyText="No matches."
          />
        </Field>
        <Field label="VRF">
          <Combobox
            value={vrfId}
            onChange={(v) => setVrfId(v ?? KEEP)}
            options={[
              { value: KEEP, label: "(keep)" },
              { value: NONE, label: "No VRF" },
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
        <FieldEditor
          spec={DESCRIPTION[0]}
          mode="keep"
          value={description}
          onChange={(v) => setDescription(String(v ?? ""))}
          onClear={() => setDescription(undefined)}
          options={editorOptions}
        />
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
