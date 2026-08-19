import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type VirtPlacementRule,
  type VirtualMachine,
  type VirtualizationSource,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { buildVmColumns } from "@/components/columns/vm-columns"
import { FormSelect, FormText } from "@/components/forms"
import { InfoTip } from "@/components/ui/info-tip"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { SyncStatusBadge } from "@/components/integrations/sync-status-badge"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { useUrlTab } from "@/lib/use-url-tab"

export const Route = createFileRoute("/virtualization-sources/$id")({
  component: SourceDetailPage,
})

const SCOPES = [
  { value: "datacenter", label: "Datacenter" },
  { value: "cluster", label: "Cluster" },
  { value: "folder", label: "Folder" },
  { value: "host", label: "Host" },
]

function SourceDetailPage() {
  const { id } = Route.useParams()
  const [tab, setTab] = useUrlTab<
    "overview" | "vms" | "placement" | "skipped"
  >("overview")

  const query = useQuery({
    queryKey: ["virtualization-source", id],
    queryFn: () => api<VirtualizationSource>(`/api/virtualization-sources/${id}/`),
  })
  const vms = useQuery({
    queryKey: ["source-vms", id],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?virt_source=${id}&page_size=1`
      ),
  })
  const vmCount = vms.data?.count ?? 0
  const source = query.data
  if (query.isError) return <QueryError error={query.error} />
  if (!source) return <p className="text-sm text-muted-foreground">Loading…</p>

  const skipped = source.last_sync_skipped ?? []
  const rows: KvRow[] = [
    { label: "Platform", value: source.kind_display },
    {
      label: "API",
      value: (
        <span className="font-mono text-xs">
          https://{source.host}:{source.port}
        </span>
      ),
    },
    { label: "Mode", value: source.sync_mode },
    { label: "Address VRF", value: source.vrf_name || dash },
    {
      label: "Poll interval",
      value: `${source.poll_interval_minutes} min`,
    },
    {
      label: "Last sync",
      value: source.last_sync_at ? (
        <span className="flex items-center gap-2">
          <SyncStatusBadge
            status={source.last_sync_status}
            error={source.last_sync_error}
            skipped={skipped}
          />
          <TimeCell iso={source.last_sync_at} />
        </span>
      ) : (
        dash
      ),
    },
  ]
  const imports: KvRow[] = [
    { label: "Disks", value: source.sync_disks ? "Yes" : "No" },
    { label: "Switches & networks", value: source.sync_networks ? "Yes" : "No" },
    { label: "Hosts as devices", value: source.sync_hosts ? "Yes" : "No" },
  ]

  return (
    <DetailShell
      backTo="/virtualization-sources"
      backLabel="Virtualization sources"
      title={source.name}
      hero={
        <DetailHero
          title={source.name}
          badges={
            <SyncStatusBadge
              status={source.last_sync_status}
              error={source.last_sync_error}
              skipped={skipped}
            />
          }
          statCols={2}
          stats={
            <>
              <DetailStat
                label="Platform"
                value={<span className="text-xs">{source.kind_display}</span>}
              />
              <DetailStat
                label="Skipped last run"
                value={<span className="num">{skipped.length}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "vms", label: "Virtual machines", count: vmCount },
        { value: "placement", label: "Placement" },
        { value: "skipped", label: "Skipped", count: skipped.length },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Connection" rows={rows} />
          <KvCard title="What it imports" rows={imports} />
        </div>
      </DetailTab>

      <DetailTab value="vms">
        <SourceVms sourceId={source.id} />
      </DetailTab>

      <DetailTab value="placement">
        <PlacementRules source={source} />
      </DetailTab>

      <DetailTab value="skipped">
        <SkippedList items={skipped} />
      </DetailTab>
    </DetailShell>
  )
}

/** The VMs this source is syncing.
 *
 * Answers "what does this connection actually see?" without making the
 * operator go to the VM list and work out which rows came from where. */
function SourceVms({ sourceId }: { sourceId: string }) {
  const query = useQuery({
    queryKey: ["source-vms-list", sourceId],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?virt_source=${sourceId}&page_size=200`
      ),
  })
  const columns = useMemo(
    () =>
      buildVmColumns<VirtualMachine>({
        include: ["name", "power", "cluster", "site", "primary_ip", "vcpus"],
      }),
    []
  )
  if (query.isError) return <QueryError error={query.error} />
  const rows = query.data?.results ?? []
  if (!query.isLoading && rows.length === 0)
    return (
      <EmptyState title="No virtual machines yet.">
        They appear after the first successful sync. In review mode, changes
        wait in the review inbox until you accept them.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="source-vms"
      flexColumn="name"
      embedded
    />
  )
}

/** What the last run saw but couldn't record.
 *
 * Not errors and not drift — the sync succeeded. These are things with nowhere
 * to go: an address with no containing prefix, a host with no matching site.
 * Each line names its own fix, so this reads as a to-do list. */
function SkippedList({ items }: { items: string[] }) {
  if (items.length === 0)
    return (
      <EmptyState title="Nothing was skipped.">
        Everything the last sync found had somewhere to go.
      </EmptyState>
    )
  // The first line is the run's summary when there is one; it reads as a
  // heading rather than another item.
  const [head, ...rest] = items
  const isSummary = /could not be placed|addresses/i.test(head)
  return (
    <div className="space-y-3">
      {isSummary && (
        <p className="max-w-prose rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          {head}
        </p>
      )}
      <ul className="divide-y divide-border rounded-md border border-border">
        {(isSummary ? rest : items).map((line, i) => (
          <li key={i} className="px-3 py-1.5 font-mono text-xs">
            {line}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Placement rules, authored from what the source actually contains.
 *
 * The pattern is picked from live discovery rather than typed: a rule that
 * matches nothing looks exactly like no rule at all, so a typo would be
 * invisible. Free text stays available for globs and regexes. */
function PlacementRules({ source }: { source: VirtualizationSource }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canEdit = canDo("virtplacementrule", "add")
  const [scope, setScope] = useState("cluster")
  const [pattern, setPattern] = useState("")
  const [siteId, setSiteId] = useState<string | null>(null)

  const rules = useQuery({
    queryKey: ["virt-placement-rules", source.id],
    queryFn: () =>
      api<Paginated<VirtPlacementRule>>(
        `/api/virt-placement-rules/?source=${source.id}`
      ),
  })
  const sites = useQuery({
    queryKey: ["sites-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/sites/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const found = useQuery({
    queryKey: ["virt-discovered", source.id],
    queryFn: () =>
      api<{
        ok: boolean
        datacenter: string[]
        cluster: string[]
        folder: string[]
        host: string[]
      }>(`/api/virtualization-sources/${source.id}/discovered/`),
    staleTime: 60_000,
    retry: false,
  })

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["virt-placement-rules", source.id] })
  const add = useMutation({
    mutationFn: () =>
      api("/api/virt-placement-rules/", {
        method: "POST",
        body: JSON.stringify({
          source: source.id,
          scope,
          pattern: pattern.trim(),
          site_id: siteId,
        }),
      }),
    onSuccess: () => {
      toast.success("Rule added")
      setPattern("")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const del = useMutation({
    mutationFn: (r: VirtPlacementRule) =>
      api(`/api/virt-placement-rules/${r.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule removed")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const rows = rules.data?.results ?? []
  // Indexing the whole payload by scope would also reach `ok`, so pick the
  // list explicitly.
  const byScope: Record<string, string[]> = found.data?.ok
    ? {
        datacenter: found.data.datacenter,
        cluster: found.data.cluster,
        folder: found.data.folder,
        host: found.data.host,
      }
    : {}
  const suggestions = byScope[scope] ?? []
  const canAdd = pattern.trim().length > 0 && !!siteId && !add.isPending

  return (
    <div className="max-w-3xl space-y-4">
      {/* The tip is part of the sentence, so it must not wrap onto a line of
          its own — inline-flex keeps the trailing word and the icon together. */}
      <p className="max-w-prose text-sm text-muted-foreground">
        Which site a synced host or VM belongs to, decided by where it sits in
        the{" "}
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          hypervisor.
            <InfoTip>
            The nearest match wins: host beats folder beats cluster beats
            datacenter, and a folder rule also covers everything nested under
            it. With no rules at all, anything whose datacenter (or Proxmox
            cluster) matches the name of an existing site still lands there.
          </InfoTip>
        </span>
      </p>

      {rows.length === 0 ? (
        <EmptyState title="No placement rules.">
          Without rules, a host or VM is placed when its datacenter (or cluster,
          on Proxmox) matches the name of a site you already have. Add a rule
          when the names don&rsquo;t line up.
        </EmptyState>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <Badge variant="outline" className="w-24 shrink-0 justify-center text-[10px]">
                {r.scope_display}
              </Badge>
              <span className="flex-1 truncate font-mono text-xs">
                {r.pattern}
              </span>
              <span className="text-muted-foreground">&rarr;</span>
              <span className="w-40 truncate">{r.site.name}</span>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  aria-label={`Remove rule ${r.pattern}`}
                  disabled={del.isPending}
                  onClick={() => del.mutate(r)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="space-y-2 border-t border-border pt-4">
          <div className="grid gap-3 sm:grid-cols-[10rem_1fr_13rem_auto] sm:items-end">
            <FormSelect
              label="Match on"
              value={scope}
              onChange={(v) => {
                setScope(v ?? "cluster")
                setPattern("")
              }}
              options={SCOPES}
            />
            <FormText
              label="Pattern"
              value={pattern}
              onChange={setPattern}
              placeholder="Lab*  ·  regex:^dc-0[12]$"
            />
            <FormSelect
              label="Site"
              value={siteId}
              onChange={setSiteId}
              placeholder="Pick a site"
              options={(sites.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
            />
            <Button disabled={!canAdd} onClick={() => add.mutate()}>
              {add.isPending ? "Adding…" : "Add rule"}
            </Button>
          </div>

          {suggestions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">
                Found on this source:
              </span>
              {suggestions.map((name) => (
                <Button
                  key={name}
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 font-mono text-[11px]"
                  onClick={() => setPattern(name)}
                >
                  {name}
                </Button>
              ))}
            </div>
          )}
          {found.isError && (
            <p className="text-xs text-muted-foreground">
              Couldn&rsquo;t read what this source contains — type a pattern by
              hand, or check the connection.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
