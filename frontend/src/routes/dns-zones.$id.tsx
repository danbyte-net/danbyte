import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type DnsLiveRecord, type DnsZone } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { InfoTip } from "@/components/ui/info-tip"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { DetailShell, DetailHero, DetailTab } from "@/components/detail-shell"
import { SimpleTable, type SimpleColumn } from "@/components/ui/simple-table"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"
import { DnsRecordsTable } from "@/components/integrations/dns-records-table"

const OBJECT_TYPE = "integrations.dnszone"
const TABS = ["overview", "records", "live", "journal", "history"] as const
type Tab = (typeof TABS)[number]

export const Route = createFileRoute("/dns-zones/$id")({
  component: ZoneDetail,
})

function ZoneDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["dns-zone", id],
    queryFn: () => api<DnsZone>(`/api/dns-zones/${id}/`),
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

function Body({ zone }: { zone: DnsZone }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)

  const canImport = canDo("ipaddress", "add")

  const patchZone = useMutation({
    mutationFn: (body: Partial<Pick<DnsZone, "sync" | "auto_create">>) =>
      api<DnsZone>(`/api/dns-zones/${zone.id}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dns-zone"] })
      qc.invalidateQueries({ queryKey: ["dns-records"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const importAll = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number }>(
        "/api/dns-records/import_unmatched/",
        { method: "POST", body: JSON.stringify({ zone: zone.id }) }
      ),
    onSuccess: (r) => {
      toast.success(
        `Imported ${r.created} record${r.created === 1 ? "" : "s"}` +
          (r.skipped ? ` - ${r.skipped} skipped (no prefix)` : "")
      )
      qc.invalidateQueries({ queryKey: ["dns-records"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const attributes: KvRow[] = [
    { label: "Zone", value: <span className="font-mono">{zone.name}</span> },
    {
      label: "Server",
      value: zone.connection ? (
        <Link
          to="/windows-servers/$id"
          params={{ id: zone.connection }}
          className="link"
        >
          {zone.connection_name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Type",
      value: zone.managed
        ? "Managed (authored in Danbyte)"
        : zone.zone_type || dash,
    },
    {
      label: "Direction",
      value: zone.is_reverse ? "Reverse (PTR)" : "Forward",
    },
    {
      label: "Records on server",
      value: <span className="num">{zone.record_count}</span>,
    },
    {
      label: "Last seen by sync",
      value: zone.last_seen_at ? <TimeCell iso={zone.last_seen_at} /> : dash,
    },
  ]

  return (
    <DetailShell
      backTo="/dns-zones"
      backLabel="DNS zones"
      title={zone.name}
      presence={{ type: "dnszone", id: zone.id }}
      hero={
        <DetailHero
          title={zone.name}
          mono
          badges={
            <>
              <Badge variant="outline" className="text-[10px]">
                {zone.zone_type || "zone"}
                {zone.is_reverse ? " · reverse" : ""}
              </Badge>
              {zone.managed && (
                <Badge
                  variant="outline"
                  className="text-[10px] text-muted-foreground"
                >
                  managed
                </Badge>
              )}
              {zone.sync ? (
                <Badge variant="success" className="text-[10px]">
                  reconciled
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px]">
                  not reconciled
                </Badge>
              )}
            </>
          }
          subtitle={
            <span className="text-[12px] text-muted-foreground">
              {zone.connection_name}
            </span>
          }
        />
      }
      actions={
        canDo("dnszone", "change") && (
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              Reconcile
              <Switch
                checked={zone.sync}
                disabled={patchZone.isPending}
                onCheckedChange={(on) => patchZone.mutate({ sync: on })}
                aria-label="Reconcile zone"
              />
            </span>
            {zone.sync && (
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                Auto-add to IPAM
                <Switch
                  checked={zone.auto_create}
                  disabled={patchZone.isPending}
                  onCheckedChange={(on) =>
                    patchZone.mutate({ auto_create: on })
                  }
                  aria-label="Auto-create IPs from records"
                />
              </span>
            )}
          </div>
        )
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "records",
          label: "Records",
          count: zone.sync ? zone.record_count : undefined,
        },
        { value: "live", label: "Live records" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(t) => setTab(t as Tab)}
    >
      <DetailTab value="overview">
        <div className="max-w-2xl">
          <KvCard title="Attributes" rows={attributes} />
        </div>
      </DetailTab>

      <DetailTab value="records">
        {!zone.sync ? (
          <EmptyState title="This zone isn't reconciled.">
            Turn on Reconcile to store its A/AAAA/PTR records here and link them
            to your IP addresses. The Live records tab always shows the server's
            current contents.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                Records
                <InfoTip>
                  Address records (A/AAAA/PTR) synced from this zone, linked to
                  their IP addresses. Other types (CNAME, MX, TXT…) aren't
                  stored - see the Live records tab for the full dump.
                </InfoTip>
              </h3>
              {canImport && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={importAll.isPending}
                  onClick={() => importAll.mutate()}
                >
                  {importAll.isPending
                    ? "Importing…"
                    : "Add all unmatched to IPAM"}
                </Button>
              )}
            </div>
            <DnsRecordsTable
              params={`zone=${zone.id}`}
              queryKey={["dns-records", "zone", zone.id]}
              showZone={false}
              empty="No address records synced yet."
            />
          </div>
        )}
      </DetailTab>

      <DetailTab value="live">
        <LiveRecords zone={zone} />
      </DetailTab>

      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={zone.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={zone.id} />
      </DetailTab>
    </DetailShell>
  )
}

const liveColumns: SimpleColumn<DnsLiveRecord>[] = [
  {
    id: "name",
    header: "Name",
    cell: (r) => <span className="font-mono text-xs">{r.HostName}</span>,
  },
  { id: "type", header: "Type", cell: (r) => r.rtype },
  {
    id: "ttl",
    header: "TTL",
    cell: (r) => <span className="text-muted-foreground">{r.ttl}</span>,
  },
  {
    id: "data",
    header: "Data",
    flex: true,
    cell: (r) => <span className="font-mono text-xs">{r.data || dash}</span>,
  },
]

function LiveRecords({ zone }: { zone: DnsZone }) {
  const q = useQuery({
    queryKey: ["dns-zone-records", zone.id],
    queryFn: () =>
      api<{ ok: boolean; records: DnsLiveRecord[]; error?: string }>(
        `/api/dns-zones/${zone.id}/records/`
      ),
    staleTime: 30_000,
  })
  const rows = q.data?.records ?? []
  return (
    <div>
      {q.isLoading && (
        <p className="text-sm text-muted-foreground">
          Asking the server directly…
        </p>
      )}
      {q.data && !q.data.ok && (
        <p className="text-sm text-destructive">{q.data.error}</p>
      )}
      {rows.length > 0 && (
        <div className="max-h-[70vh] overflow-auto">
          <SimpleTable
            columns={liveColumns}
            data={rows}
            getRowKey={(_, i) => i}
          />
        </div>
      )}
      {q.data?.ok && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">The zone is empty.</p>
      )}
    </div>
  )
}
