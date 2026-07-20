import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Paginated, type Prefix, type VRF } from "@/lib/api"
import { TagList } from "@/components/cells/tag-list"
import { ColorBadge } from "@/components/cells/color-badge"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { Button } from "@/components/ui/button"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { DataTable } from "@/components/data-table"
import { buildPrefixColumns } from "@/components/columns/prefix-columns"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { VrfDeleteDialog } from "@/components/vrf-delete-dialog"
import { ViolationBadge } from "@/components/compliance/violation-badge"
import { EmbeddedIpTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/vrfs/$id")({ component: VrfDetail })

function VrfDetail() {
  const { id } = Route.useParams()
  const vrf = useQuery({
    queryKey: ["vrf", id],
    queryFn: () => api<VRF>(`/api/vrfs/${id}/`),
  })
  if (vrf.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (vrf.isError)
    return (
      <div className="p-6">
        <QueryError error={vrf.error} />
      </div>
    )
  if (!vrf.data) return null
  return <VrfDetailBody vrf={vrf.data} />
}

function VrfDetailBody({ vrf: v }: { vrf: VRF }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "prefixes" | "ips" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const canEdit = canDo("vrf", "change")
  const canDelete = canDo("vrf", "delete")
  const [deleting, setDeleting] = useState<VRF | null>(null)
  const openDelete = useCallback(() => setDeleting(v), [v])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/vrfs" }), [nav])

  return (
    <DetailShell
      backTo="/vrfs"
      backLabel="VRFs"
      title={v.name}
      presence={{ type: "vrf", id: v.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/vrfs/$id/edit" params={{ id: v.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <ColorBadge
                name={v.name}
                color={v.color || undefined}
                className="h-7 px-3 text-sm"
              />
              {v.rd && (
                <span className="font-mono text-sm text-muted-foreground">
                  RD {v.rd}
                </span>
              )}
              <ViolationBadge objectId={v.id} prominent />
            </div>
            {v.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={v.tags} />
              </div>
            )}
            {v.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {v.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Prefixes"
              value={<span className="num">{v.prefix_count}</span>}
            />
            <DetailStat
              label="IPs"
              value={<span className="num">{v.ip_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "prefixes", label: "Prefixes", count: v.prefix_count },
        { value: "ips", label: "IPs", count: v.ip_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <VrfOverview vrf={v} humanIds={humanIds} />
      </DetailTab>
      <DetailTab value="prefixes">
        <VrfPrefixesTable vrfId={v.id} />
      </DetailTab>
      <DetailTab value="ips">
        <EmbeddedIpTable filter={{ vrf: v.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.vrf" objectId={v.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.vrf" objectId={v.id} />
      </DetailTab>

      <VrfDeleteDialog
        vrf={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function rtValue(rts: { id: string; name: string }[]): React.ReactNode {
  if (rts.length === 0) return dash
  return (
    <div className="flex flex-wrap items-center gap-1">
      {rts.map((rt) => (
        <Link
          key={rt.id}
          to="/route-targets/$id"
          params={{ id: rt.id }}
          className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground hover:bg-muted/80"
        >
          {rt.name}
        </Link>
      ))}
    </div>
  )
}

/** VRF attributes that used to crowd the header, grouped into tables. */
function VrfOverview({ vrf: v, humanIds }: { vrf: VRF; humanIds: boolean }) {
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
      label: "Route distinguisher",
      value: v.rd ? (
        <span className="font-mono text-[13px]">{v.rd}</span>
      ) : (
        dash
      ),
      copy: v.rd || undefined,
    },
    { label: "IPs", value: <span className="num">{v.ip_count}</span> },
    { label: "Enforce unique", value: v.enforce_unique ? "Yes" : "No" },
  ]
  const routeTargets: KvRow[] = [
    { label: "Import targets", value: rtValue(v.import_targets) },
    { label: "Export targets", value: rtValue(v.export_targets) },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <KvCard title="Route targets" rows={routeTargets} />
    </div>
  )
}

function VrfPrefixesTable({ vrfId }: { vrfId: string }) {
  const q = useQuery({
    queryKey: ["vrf-prefixes", vrfId],
    queryFn: () =>
      api<Paginated<Prefix>>(`/api/prefixes/?vrf=${vrfId}&page_size=500`),
  })
  const columns = useMemo<ColumnDef<Prefix>[]>(
    () => buildPrefixColumns({ omit: ["vrf"] }),
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading prefixes…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) {
    return (
      <EmptyState title="No prefixes yet.">
        No prefixes are tied to this VRF.
      </EmptyState>
    )
  }
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="prefix-embedded"
    />
  )
}
