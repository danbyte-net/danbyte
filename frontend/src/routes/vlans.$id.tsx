import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { CopyPlus, Pencil, Plus, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Prefix, type VLAN } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
import { VlanAssignPrefixDialog } from "@/components/vlan-assign-prefix-dialog"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { VlanDeleteDialog } from "@/components/vlan-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vlans/$id")({ component: VlanDetail })

function VlanDetail() {
  const { id } = Route.useParams()
  const vlan = useQuery({
    queryKey: ["vlan", id],
    queryFn: () => api<VLAN>(`/api/vlans/${id}/`),
  })

  if (vlan.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (vlan.isError)
    return (
      <div className="p-6">
        <QueryError error={vlan.error} />
      </div>
    )
  if (!vlan.data) return null
  return <VlanDetailBody vlan={vlan.data} />
}

function VlanDetailBody({ vlan: v }: { vlan: VLAN }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "prefixes" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("vlan", "change")
  const canDelete = canDo("vlan", "delete")
  const [deleting, setDeleting] = useState<VLAN | null>(null)

  const openDelete = useCallback(() => setDeleting(v), [v])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/vlans" }), [nav])

  return (
    <DetailShell
      backTo="/vlans"
      backLabel="VLANs"
      title={
        <span className="font-mono">
          {v.vlan_id} · {v.name}
        </span>
      }
      presence={{ type: "vlan", id: v.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vlans/$id/edit" params={{ id: v.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("vlan", "add") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vlans/new" search={{ clone: v.id }}>
                <CopyPlus className="h-3.5 w-3.5" /> Clone
              </Link>
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          // Coloured catalog object → the ColorBadge is the title (design
          // system rule), so the VLAN's colour is visible on its own page.
          title={
            <ColorBadge
              name={`VLAN ${v.vlan_id}`}
              color={v.color || v.zone?.color || undefined}
              className="font-mono"
            />
          }
          badges={
            <>
              <span className="text-sm text-muted-foreground">{v.name}</span>
              <ViolationBadge objectId={v.id} prominent />
            </>
          }
          tags={v.tags.length > 0 && <TagList tags={v.tags} />}
          description={v.description}
          stats={
            <DetailStat
              label="Prefixes"
              value={<span className="num">{v.prefix_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "prefixes", label: "Prefixes", count: v.prefix_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VlanOverview vlan={v} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="prefixes">
        <VlanPrefixesTable vlanId={v.id} vlanLabel={`VLAN ${v.vlan_id}`} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.vlan" objectId={v.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.vlan" objectId={v.id} />
      </DetailTab>

      <VlanDeleteDialog
        vlan={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** VLAN attributes that used to crowd the header, grouped into a table. */
function VlanOverview({
  vlan: v,
  humanIds,
}: {
  vlan: VLAN
  humanIds: boolean
}) {
  const attributes: KvRow[] = [
    ...(humanIds && v.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{v.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "VLAN ID",
      value: <span className="num font-mono">{v.vlan_id}</span>,
    },
    { label: "Site", value: v.site?.name ?? dash },
    {
      label: "Updated",
      value: <TimeCell iso={v.updated_at} />,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <CustomFieldValues model="vlan" values={v.custom_fields} layout="cards" />
    </div>
  )
}

function VlanPrefixesTable({
  vlanId,
  vlanLabel,
}: {
  vlanId: string
  vlanLabel: string
}) {
  const { canDo } = useMe()
  const [assigning, setAssigning] = useState(false)
  const q = useQuery({
    queryKey: ["vlan-prefixes", vlanId],
    queryFn: () =>
      api<Paginated<Prefix>>(`/api/prefixes/?vlan=${vlanId}&page_size=500`),
  })

  const columns = useMemo<ColumnDef<Prefix>[]>(() => buildPrefixColumns(), [])

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading prefixes…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  return (
    <div className="space-y-3">
      {/* Same pair the site page's prefixes tab has: pull an existing prefix
          onto this VLAN, or create a new one already on it. */}
      <div className="flex items-center gap-2">
        {canDo("prefix", "change") && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => setAssigning(true)}
          >
            <Plus className="h-3.5 w-3.5" /> Assign prefix
          </Button>
        )}
        {canDo("prefix", "add") && (
          <Button
            size="sm"
            className={canDo("prefix", "change") ? "" : "ml-auto"}
            asChild
          >
            <Link
              to="/prefixes/new"
              search={{
                cidr: undefined,
                vrf: undefined,
                site: undefined,
                location: undefined,
                vlan: vlanId,
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Add prefix
            </Link>
          </Button>
        )}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No prefixes yet.">
          No prefixes are tied to this VLAN.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="description"
          tableId="prefix-embedded"
        />
      )}
      <VlanAssignPrefixDialog
        vlanId={vlanId}
        vlanLabel={vlanLabel}
        open={assigning}
        onOpenChange={setAssigning}
      />
    </div>
  )
}
