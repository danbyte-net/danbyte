import { createFileRoute, Link } from "@tanstack/react-router"
import { useCallback, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Plug, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Device,
  type Paginated,
  type VirtPlacementRule,
  type VirtualMachine,
  type VirtualizationSource,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { copyText } from "@/lib/clipboard"
import { RowActions } from "@/components/row-actions"
import { buildDeviceColumns } from "@/components/columns/device-columns"
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
import { SourceDialog } from "./virtualization-sources.index"

export const Route = createFileRoute("/virtualization-sources/$id")({
  component: SourceDetailPage,
})

const SCOPES = [
  { value: "datacenter", label: "Datacenter" },
  { value: "cluster", label: "Cluster" },
  { value: "folder", label: "Folder" },
  { value: "host", label: "Host" },
  { value: "ip", label: "IP address" },
]

// The pattern means something different per scope, so the placeholder should
// too - a glob over names is not a subnet.
const PATTERN_HINT: Record<string, string> = {
  ip: "10.0.9.0/24  ·  192.168.110.*",
}

function SourceDetailPage() {
  const { id } = Route.useParams()
  const [tab, setTab] = useUrlTab<
    "overview" | "vms" | "hosts" | "placement" | "skipped" | "log"
  >("overview")

  const query = useQuery({
    queryKey: ["virtualization-source", id],
    queryFn: () => api<VirtualizationSource>(`/api/virtualization-sources/${id}/`),
  })
  const ruleCount = useQuery({
    queryKey: ["virt-placement-rules", id],
    queryFn: () =>
      api<Paginated<VirtPlacementRule>>(
        `/api/virt-placement-rules/?source=${id}`
      ),
  })
  const vms = useQuery({
    queryKey: ["source-vms", id],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?virt_source=${id}&page_size=1`
      ),
  })
  const vmCount = vms.data?.count ?? 0
  const hosts = useQuery({
    queryKey: ["source-hosts", id],
    queryFn: () =>
      api<Paginated<Device>>(`/api/devices/?virt_source=${id}&page_size=1`),
  })
  const hostCount = hosts.data?.count ?? 0
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState(false)

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["virtualization-source", id] })
    qc.invalidateQueries({ queryKey: ["source-vms", id] })
    qc.invalidateQueries({ queryKey: ["source-vms-list", id] })
  }
  const syncNow = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean
        vms?: number
        interfaces?: number
        ips?: number
        ips_skipped?: number
        hosts?: number
        error?: string
      }>(`/api/virtualization-sources/${id}/sync/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (!r.ok) {
        toast.error(r.error || "Sync failed")
      } else {
        let base = `Synced: ${r.vms ?? 0} VMs, ${r.interfaces ?? 0} interfaces, ${r.ips ?? 0} IPs`
        if (r.hosts) base += `, ${r.hosts} host${r.hosts === 1 ? "" : "s"}`
        const unplaced = r.ips_skipped ?? 0
        if (unplaced)
          toast.warning(
            `${base} · ${unplaced} address${unplaced === 1 ? "" : "es"} unplaced`
          )
        else toast.success(base)
      }
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })
  const test = useMutation({
    mutationFn: () =>
      api<{
        ok: boolean
        product?: string
        version?: string
        nodes?: number
        online_nodes?: number
        vms?: number
        error?: string
      }>(`/api/virtualization-sources/${id}/test/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (r) => {
      if (!r.ok) return toast.error(r.error || "Probe failed")
      const name = [r.product, r.version].filter(Boolean).join(" ")
      const parts = [`${r.online_nodes}/${r.nodes} nodes online`]
      if (r.vms !== undefined) parts.push(`${r.vms} VMs`)
      toast.success(`Connected - ${name}, ${parts.join(", ")}`)
    },
    onError: (e) => apiErrorToast(e),
  })
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
    { label: "Platforms", value: source.sync_platforms ? "Yes" : "No" },
    ...(source.kind === "vcenter"
      ? [
          {
            label: "Host hardware",
            value: source.sync_host_hardware ? "Yes" : "No",
          } satisfies KvRow,
        ]
      : []),
  ]

  return (
    <DetailShell
      backTo="/virtualization-sources"
      backLabel="Virtualization sources"
      title={source.name}
      actions={
        <>
          {canDo("virtualizationsource", "change") && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            <Plug className="h-3.5 w-3.5" />
            {test.isPending ? "Testing…" : "Test"}
          </Button>
          {canDo("virtualizationsource", "change") && (
            <Button
              size="sm"
              disabled={syncNow.isPending}
              onClick={() => syncNow.mutate()}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${syncNow.isPending ? "animate-spin" : ""}`}
              />
              {syncNow.isPending ? "Syncing…" : "Sync now"}
            </Button>
          )}
        </>
      }
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
        { value: "hosts", label: "Hosts", count: hostCount },
        {
          value: "placement",
          label: "Placement",
          count: ruleCount.data?.count || undefined,
        },
        { value: "skipped", label: "Skipped", count: skipped.length },
        { value: "log", label: "Sync log" },
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

      <DetailTab value="hosts">
        <SourceHosts sourceId={id} />
      </DetailTab>

      <DetailTab value="placement">
        <PlacementRules source={source} />
      </DetailTab>

      <DetailTab value="skipped">
        <SkippedList items={skipped} />
      </DetailTab>

      <DetailTab value="log">
        {source.last_sync_log ? (
          <div className="space-y-2">
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void copyText(source.last_sync_log)
                  toast.success("Sync log copied")
                }}
              >
                Copy log
              </Button>
            </div>
            <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/20 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
              {source.last_sync_log}
            </pre>
          </div>
        ) : (
          <EmptyState title="No sync log yet">
            The log of a run appears here after the next sync completes.
          </EmptyState>
        )}
      </DetailTab>

      {editing && (
        <SourceDialog
          source={source}
          onOpenChange={(o) => {
            setEditing(o)
            if (!o) refresh()
          }}
        />
      )}
    </DetailShell>
  )
}

/** The VMs this source is syncing.
 *
 * Answers "what does this connection actually see?" without making the
 * operator go to the VM list and work out which rows came from where. */
const VM_PAGE = 500

function SourceVms({ sourceId }: { sourceId: string }) {
  const { humanIds } = useMe()
  const query = useQuery({
    queryKey: ["source-vms-list", sourceId],
    queryFn: () =>
      api<Paginated<VirtualMachine>>(
        `/api/virtual-machines/?virt_source=${sourceId}&page_size=${VM_PAGE}`
      ),
  })
  // The full column set, not a cut-down one: this tab answers "what does this
  // connection actually see", which is a VM list that happens to be filtered -
  // so it gets the same columns, facets and column preferences as the real one.
  const columns = useMemo(
    () => buildVmColumns<VirtualMachine>({ humanIds }),
    [humanIds]
  )
  if (query.isError) return <QueryError error={query.error} />
  const rows = query.data?.results ?? []
  const total = query.data?.count ?? 0
  if (!query.isLoading && rows.length === 0)
    return (
      <EmptyState title="No virtual machines yet.">
        They appear after the first successful sync. In review mode, changes
        wait in the review inbox until you accept them.
      </EmptyState>
    )
  return (
    <div className="space-y-2">
      <DataTable
        data={rows}
        columns={columns}
        tableId="source-vms"
        flexColumn="name"
        embedded
      />
      {total > rows.length && (
        // Never let a cap look like the whole truth.
        <p className="text-xs text-muted-foreground">
          Showing the first {rows.length} of {total}.
        </p>
      )}
    </div>
  )
}

/** The physical hosts behind this source.
 *
 * There is no foreign key from a Device to a source - the link is that the
 * source syncs VMs onto them, or into a cluster they belong to. Ticking
 * "Create hosts as devices" is what puts them here in the first place. */
function SourceHosts({ sourceId }: { sourceId: string }) {
  const { humanIds } = useMe()
  const query = useQuery({
    queryKey: ["source-hosts-list", sourceId],
    queryFn: () =>
      api<Paginated<Device>>(
        `/api/devices/?virt_source=${sourceId}&page_size=200`
      ),
  })
  const columns = useMemo(
    () =>
      buildDeviceColumns<Device>({
        humanIds,
        include: ["numid", "name", "status", "type", "manufacturer", "serial",
                  "site", "platform"],
      }),
    [humanIds]
  )
  if (query.isError) return <QueryError error={query.error} />
  const rows = query.data?.results ?? []
  if (!query.isLoading && rows.length === 0)
    return (
      <EmptyState title="No hosts linked yet.">
        Hosts appear once they exist as devices - either create them yourself
        with names matching what the hypervisor reports, or tick{" "}
        <span className="font-medium">Create hosts as devices</span> on this
        source.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      tableId="source-hosts"
      flexColumn="name"
      embedded
    />
  )
}

/** What the last run saw but couldn't record.
 *
 * Not errors and not drift - the sync succeeded. These are things with nowhere
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
  const [locationId, setLocationId] = useState<string | null>(null)
  const [weight, setWeight] = useState("100")
  // The same form edits an existing rule; null means "adding a new one".
  const [editingId, setEditingId] = useState<string | null>(null)

  const reset = () => {
    setEditingId(null)
    setPattern("")
    setSiteId(null)
    setLocationId(null)
    setWeight("100")
  }
  // useCallback because the columns memo depends on it - a fresh function each
  // render would rebuild the table on every render.
  const startEdit = useCallback((r: VirtPlacementRule) => {
    setEditingId(r.id)
    setScope(r.scope)
    setPattern(r.pattern)
    setSiteId(r.site.id)
    setLocationId(r.location?.id ?? null)
    setWeight(String(r.weight))
  }, [])

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
  // Only locations inside the chosen site can be used - one outside it would
  // place a device somewhere it physically isn't, and the API refuses it.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        `/api/locations/?site=${siteId}&page_size=200`
      ),
    enabled: !!siteId,
    staleTime: 60_000,
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
  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        source: source.id,
        scope,
        pattern: pattern.trim(),
        site_id: siteId,
        location_id: locationId,
        weight: Number(weight) || 100,
      })
      return editingId
        ? api(`/api/virt-placement-rules/${editingId}/`, {
            method: "PATCH",
            body,
          })
        : api("/api/virt-placement-rules/", { method: "POST", body })
    },
    onSuccess: () => {
      toast.success(editingId ? "Rule updated" : "Rule added")
      reset()
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const del = useMutation({
    mutationFn: (r: VirtPlacementRule) =>
      api(`/api/virt-placement-rules/${r.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Rule removed")
      reset()
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const rows = rules.data?.results ?? []
  const ruleColumns = useMemo<ColumnDef<VirtPlacementRule>[]>(
    () => [
      {
        id: "scope",
        accessorFn: (r) => r.scope_display,
        header: ({ column }) => <SortHeader column={column} label="Match on" />,
        cell: ({ row }) => (
          <Badge variant="outline" className="text-[10px]">
            {row.original.scope_display}
          </Badge>
        ),
      },
      {
        id: "pattern",
        accessorKey: "pattern",
        header: ({ column }) => <SortHeader column={column} label="Pattern" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">{row.original.pattern}</span>
        ),
      },
      {
        id: "site",
        accessorFn: (r) => r.site.name,
        header: ({ column }) => <SortHeader column={column} label="Site" />,
        cell: ({ row }) => (
          <Link
            to="/sites/$id"
            params={{ id: row.original.site.id }}
            className="link"
          >
            {row.original.site.name}
          </Link>
        ),
      },
      {
        id: "location",
        accessorFn: (r) => r.location?.name ?? "",
        header: "Location",
        cell: ({ row }) => row.original.location?.name ?? dash,
      },
      {
        id: "weight",
        accessorKey: "weight",
        header: ({ column }) => <SortHeader column={column} label="Weight" />,
        cell: ({ row }) => (
          <span className="num">{row.original.weight}</span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            onEdit={canEdit ? () => startEdit(row.original) : undefined}
            onDelete={canEdit ? () => del.mutate(row.original) : undefined}
            deleteLabel="Remove"
          />
        ),
      },
    ],
    [canEdit, del, startEdit]
  )
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
  const canSave = pattern.trim().length > 0 && !!siteId && !save.isPending

  return (
    <div className="space-y-4">
      {/* The tip is part of the sentence, so it must not wrap onto a line of
          its own - inline-flex keeps the trailing word and the icon together. */}
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
        <DataTable
          data={rows}
          columns={ruleColumns}
          tableId="placement-rules"
          flexColumn="pattern"
          embedded
        />
      )}

      {canEdit && (
        <div className="space-y-3 rounded-lg border border-border p-4">
          <p className="text-xs font-medium">
            {editingId ? "Edit rule" : "Add a rule"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[11rem_minmax(14rem,1fr)_13rem_13rem_7rem] lg:items-end">
            <FormSelect
              label="Match on"
              value={scope}
              onChange={(v) => {
                setScope(v ?? "cluster")
                if (!editingId) setPattern("")
              }}
              options={SCOPES}
            />
            <FormText
              label="Pattern"
              value={pattern}
              onChange={setPattern}
              placeholder={PATTERN_HINT[scope] ?? "Lab*  ·  regex:^dc-0[12]$"}
              info={
                scope === "ip"
                  ? "A subnet in CIDR form, or a glob. Prefer CIDR - a glob only reaches octet boundaries, so it cannot express a /22. Matches any address the hypervisor reports for the machine. Host addresses come from vSphere over SOAP, so vCenter sources read them on the same call as host hardware."
                  : undefined
              }
            />
            <FormSelect
              label="Site"
              value={siteId}
              onChange={(v) => {
                setSiteId(v)
                setLocationId(null)  // a location only belongs to one site
              }}
              placeholder="Pick a site"
              options={(sites.data?.results ?? []).map((s) => ({
                value: s.id,
                label: s.name,
              }))}
            />
            <FormSelect
              label="Location"
              info="Optional. Only locations inside the site above are offered - a location elsewhere would place the machine where it isn't."
              value={locationId}
              onChange={setLocationId}
              noneLabel="None"
              disabled={!siteId}
              options={(locations.data?.results ?? []).map((l) => ({
                value: l.id,
                label: l.name,
              }))}
            />
            <FormText
              label="Weight"
              info="Only breaks ties between rules that match at the same level - lower wins. Specificity comes first, so a host rule always beats a cluster rule whatever the weights."
              value={weight}
              onChange={setWeight}
            />
          </div>
          <div className="flex items-center gap-2">
            <Button disabled={!canSave} onClick={() => save.mutate()}>
              {save.isPending
                ? "Saving…"
                : editingId
                  ? "Save rule"
                  : "Add rule"}
            </Button>
            {editingId && (
              <Button variant="ghost" onClick={reset}>
                Cancel
              </Button>
            )}
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
              Couldn&rsquo;t read what this source contains - type a pattern by
              hand, or check the connection.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
