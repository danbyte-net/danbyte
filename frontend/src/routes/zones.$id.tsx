import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type VLAN, type Zone } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { SiteCell } from "@/components/cells/site-cell"
import { TagList } from "@/components/cells/tag-list"
import { DataTable, SortHeader } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { ZoneDeleteDialog } from "@/components/zone-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
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
  const [tab, setTab] = useState<"vlans" | "journal" | "history">("vlans")
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
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <ColorBadge name={z.name} color={z.color || undefined} />
                <LocalityBadge owningSite={z.owning_site} />
                {canPromote && (
                  <PromoteToGlobalButton
                    url={`/api/zones/${z.id}/promote/`}
                    name={z.name}
                    invalidate={[["zones"], ["zones-picker"], ["zone", z.id]]}
                  />
                )}
              </div>
              {z.tags.length > 0 && (
                <div className="mt-2">
                  <TagList tags={z.tags} />
                </div>
              )}
              {z.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {z.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="VLANs"
                value={<span className="num">{z.usage_count}</span>}
              />
              <DetailStat
                label="Weight"
                value={<span className="num">{z.weight}</span>}
              />
            </dl>
          </section>

          <section className="shrink-0 border-b border-border px-6 py-4">
            <p className="text-sm text-muted-foreground">
              {z.usage_count > 0
                ? `${z.usage_count} VLAN${z.usage_count === 1 ? "" : "s"} currently sit in this zone.`
                : "No VLANs use this zone yet."}
            </p>
          </section>

          <CustomFieldValues model="zone" values={z.custom_fields} />
        </>
      }
      tabs={[
        { value: "vlans", label: "VLANs", count: z.usage_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="vlans">
        <ZoneVlansTable zoneId={z.id} />
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

function ZoneVlansTable({ zoneId }: { zoneId: string }) {
  const q = useQuery({
    queryKey: ["vlans"],
    queryFn: () => api<Paginated<VLAN>>("/api/vlans/"),
  })
  const rows = useMemo(
    () => (q.data?.results ?? []).filter((v) => v.zone?.id === zoneId),
    [q.data, zoneId]
  )
  const columns = useMemo<ColumnDef<VLAN>[]>(
    () => [
      {
        id: "vlan_id",
        accessorKey: "vlan_id",
        header: ({ column }) => <SortHeader column={column} label="VLAN" />,
        cell: ({ row }) => (
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="num font-mono text-xs font-medium hover:underline"
          >
            {row.original.vlan_id}
          </Link>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/vlans/$id"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "site",
        accessorFn: (v) => v.site?.name ?? "",
        header: "Site",
        cell: ({ row }) => <SiteCell site={row.original.site} />,
      },
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="line-clamp-1 block text-muted-foreground">
            {row.original.description || "—"}
          </span>
        ),
      },
    ],
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No VLANs in this zone yet.
      </p>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="zone-vlans"
    />
  )
}
