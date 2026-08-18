import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLAN, type Zone } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { buildVlanColumns } from "@/components/columns/vlan-columns"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ZoneDeleteDialog } from "@/components/zone-delete-dialog"
import { ZoneAssignVlanDialog } from "@/components/zone-assign-vlan-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import {
  LocalityBadge,
  PromoteToGlobalButton,
} from "@/components/locality-badge"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/zones/$id")({
  component: ZoneDetail,
})

function ZoneDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["zone", id],
    queryFn: () => api<Zone>(`/api/zones/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body zone={q.data} />
}

function Body({ zone: z }: { zone: Zone }) {
  const [tab, setTab] = useUrlTab<"overview" | "vlans" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo, editableSites } = useMe()
  const canEdit = canDo("zone", "change")
  const canDelete = canDo("zone", "delete")
  const canPromote = !!z.owning_site && editableSites === "all" && canEdit
  const [deleting, setDeleting] = useState<Zone | null>(null)
  const goBack = useCallback(() => nav({ to: "/zones" }), [nav])

  return (
    <DetailShell
      backTo="/zones"
      backLabel="Zones"
      title={z.name}
      presence={{ type: "zone", id: z.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/zones/$id/edit" params={{ id: z.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(z)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <>
          <DetailHero
            title={<ColorBadge name={z.name} color={z.color || undefined} />}
            badges={
              <>
                <LocalityBadge owningSite={z.owning_site} />
                {canPromote && (
                  <PromoteToGlobalButton
                    url={`/api/zones/${z.id}/promote/`}
                    name={z.name}
                    invalidate={[["zones"], ["zones-picker"], ["zone", z.id]]}
                  />
                )}
              </>
            }
            tags={z.tags.length > 0 && <TagList tags={z.tags} />}
            description={z.description}
            stats={
              <DetailStat
                label="VLANs"
                value={<span className="num">{z.usage_count}</span>}
              />
            }
          />

          <section className="shrink-0 border-b border-border px-6 py-4">
            <p className="text-sm text-muted-foreground">
              {z.usage_count > 0
                ? `${z.usage_count} VLAN${z.usage_count === 1 ? "" : "s"} currently sit in this zone.`
                : "No VLANs use this zone yet."}
            </p>
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vlans", label: "VLANs", count: z.usage_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <ZoneOverview zone={z} />
      </DetailTab>
      <DetailTab value="vlans">
        <ZoneVlansTable zoneId={z.id} zoneName={z.name} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.zone" objectId={z.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.zone" objectId={z.id} />
      </DetailTab>

      <ZoneDeleteDialog
        zone={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Zone attributes that used to crowd the header, grouped into tables. Only the
 * colored name badge, locality, tags, description and VLAN count stay up top. */
function ZoneOverview({ zone: z }: { zone: Zone }) {
  const attributes: KvRow[] = [
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{z.slug}</span>,
      copy: z.slug,
    },
    {
      label: "Color",
      value: z.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: z.color }}
          />
          <span className="font-mono">{z.color}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Weight", value: <span className="num">{z.weight}</span> },
  ]

  const record: KvRow[] = [
    {
      label: "Scoped to",
      value: z.owning_site ? (
        <Link
          to="/sites/$id"
          params={{ id: z.owning_site.id }}
          className="link"
        >
          {z.owning_site.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">Whole tenant</span>
      ),
    },
    { label: "Created", value: <TimeCell iso={z.created_at} /> },
    { label: "Updated", value: <TimeCell iso={z.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <KvCard title="Record" rows={record} />
      <CustomFieldValues model="zone" values={z.custom_fields} layout="cards" />
    </div>
  )
}

function ZoneVlansTable({
  zoneId,
  zoneName,
}: {
  zoneId: string
  zoneName: string
}) {
  const { canDo } = useMe()
  const [assigning, setAssigning] = useState(false)
  const q = useQuery({
    queryKey: ["vlans"],
    queryFn: () => api<Paginated<VLAN>>("/api/vlans/"),
  })
  const rows = useMemo(
    () => (q.data?.results ?? []).filter((v) => v.zone?.id === zoneId),
    [q.data, zoneId]
  )
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () =>
      buildVlanColumns({
        include: ["vlan_id", "name", "site", "description"],
      }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  return (
    <div className="space-y-2">
      {canDo("vlan", "change") && (
        <div className="flex justify-end">
          <Button size="sm" variant="outline" onClick={() => setAssigning(true)}>
            <Plus className="h-3.5 w-3.5" /> Assign VLAN
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No VLANs in this zone yet. To remove one, edit that VLAN and clear
          its zone.
        </p>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="zone-vlans"
        />
      )}
      <ZoneAssignVlanDialog
        zoneId={zoneId}
        zoneName={zoneName}
        open={assigning}
        onOpenChange={setAssigning}
      />
    </div>
  )
}
