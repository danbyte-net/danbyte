import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Play, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  InventoryProfile,
  InventoryRun,
  InventoryScopeHost,
  Paginated,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { TimeCell } from "@/components/cells/time-ago"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  buildInventoryRunColumns,
  buildInventoryScopeHostColumns,
  scheduleLabel,
} from "@/components/columns/inventory-columns"
import { ProfileDialog } from "@/components/discovery/profile-dialog"
import { isRunActive, RunStatusBadge } from "@/components/discovery/status"

// One inventory profile (#451 B2): Overview (scope, schedule, recorded
// authorisation), Hosts (the scope as it resolves now, nothing contacted),
// Runs, then Journal and Change log.

const OBJECT_TYPE = "discovery.inventoryprofile"
type Tab = "overview" | "hosts" | "runs" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "hosts", "runs", "journal", "history"]

export const Route = createFileRoute("/discovery/$id")({
  component: ProfileDetail,
})

function ProfileDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["discovery", "profile", id],
    queryFn: () => api<InventoryProfile>(`/api/discovery/profiles/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body profile={q.data} />
}

function useRuns(id: string) {
  return useQuery({
    queryKey: ["discovery", "runs", id],
    queryFn: () =>
      api<Paginated<InventoryRun>>(
        `/api/discovery/runs/?profile=${id}&page_size=200`
      ),
    refetchInterval: (q) =>
      q.state.data?.results.some((r) => isRunActive(r.status)) ? 3000 : false,
  })
}

function Body({ profile: p }: { profile: InventoryProfile }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const { canDo } = useMe()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const runs = useRuns(p.id)
  const canScan = canDo("inventoryprofile", "scan")
  const busy = (runs.data?.results ?? []).some((r) => isRunActive(r.status))

  const run = useMutation({
    mutationFn: () =>
      api<InventoryRun>(`/api/discovery/profiles/${p.id}/run/`, {
        method: "POST",
      }),
    onSuccess: () => {
      toast.success("Run queued")
      qc.invalidateQueries({ queryKey: ["discovery", "runs", p.id] })
      qc.invalidateQueries({ queryKey: ["discovery", "profile", p.id] })
      setTab("runs")
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <DetailShell
      backTo="/discovery"
      backLabel="Discovery"
      title={p.name}
      actions={
        <>
          {canScan && (
            <Button
              size="sm"
              disabled={run.isPending || busy || !!p.blocked_reason}
              onClick={() => run.mutate()}
            >
              <Play className="h-3.5 w-3.5" />
              {run.isPending || busy ? "Running…" : "Run now"}
            </Button>
          )}
          {canDo("inventoryprofile", "change") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {canDo("inventoryprofile", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={p.name}
          badges={
            <>
              <Badge variant={p.enabled ? "success" : "secondary"}>
                {p.enabled ? "Enabled" : "Disabled"}
              </Badge>
              {!p.authorised && <Badge variant="warning">Not authorised</Badge>}
            </>
          }
          subtitle={p.blocked_reason || p.description || undefined}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "hosts", label: "Hosts" },
        { value: "runs", label: "Runs", count: runs.data?.count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <Overview profile={p} />
      </DetailTab>
      <DetailTab value="hosts">
        <ScopeHosts id={p.id} />
      </DetailTab>
      <DetailTab value="runs">
        <Runs id={p.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={p.id} />
      </DetailTab>
      <ProfileDialog open={editing} onOpenChange={setEditing} profile={p} />
      <DeleteDialog
        profile={deleting ? p : null}
        onOpenChange={(o) => !o && setDeleting(false)}
        onDeleted={() => nav({ to: "/discovery" })}
      />
    </DetailShell>
  )
}

function names(rows: { id: string; name: string }[]) {
  return rows.length ? (
    <span className="flex flex-wrap gap-1">
      {rows.map((r) => (
        <Badge key={r.id} variant="secondary" className="font-mono">
          {r.name}
        </Badge>
      ))}
    </span>
  ) : (
    dash
  )
}

function Overview({ profile: p }: { profile: InventoryProfile }) {
  const scope: KvRow[] = [
    { label: "Sites", value: names(p.scope.sites) },
    { label: "Prefixes", value: names(p.scope.prefixes) },
    { label: "Devices", value: names(p.scope.devices) },
    { label: "Virtual machines", value: names(p.scope.virtual_machines) },
  ]
  const schedule: KvRow[] = [
    { label: "Schedule", value: scheduleLabel(p) },
    {
      label: "Hosts at once",
      value: <span className="num">{p.max_concurrency}</span>,
    },
    {
      label: "Per-host timeout",
      value: <span className="num">{p.timeout_seconds} s</span>,
    },
    {
      label: "Last run",
      value: p.last_run ? (
        <span className="flex items-center gap-2">
          <RunStatusBadge status={p.last_run.status} />
          <TimeCell iso={p.last_run.created_at} />
        </span>
      ) : (
        <span className="text-muted-foreground">Never</span>
      ),
    },
  ]
  const auth: KvRow[] = [
    {
      label: "Statement",
      value: p.authorisation ? (
        <span className="whitespace-pre-line">{p.authorisation}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Recorded by",
      value: p.authorised ? (
        p.authorised_by_name || dash
      ) : (
        <Badge variant="warning">Not authorised</Badge>
      ),
    },
    {
      label: "Recorded",
      value: p.authorised_at ? <TimeCell iso={p.authorised_at} /> : dash,
    },
  ]
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="grid min-w-0 content-start gap-6">
        <KvCard title="Scope" rows={scope} />
        <KvCard title="Authorisation" rows={auth} />
      </div>
      <KvCard title="Schedule" rows={schedule} />
    </div>
  )
}

function ScopeHosts({ id }: { id: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const q = useQuery({
    queryKey: ["discovery", "profile", id, "hosts"],
    queryFn: () =>
      api<{ results: InventoryScopeHost[]; count: number; truncated: boolean }>(
        `/api/discovery/profiles/${id}/hosts/`
      ),
  })
  const exempt = useMutation({
    mutationFn: (h: InventoryScopeHost) =>
      api(`/api/discovery/exempt/`, {
        method: "POST",
        body: JSON.stringify({
          kind: h.kind,
          id: h.id,
          exempt: !h.scan_exempt,
        }),
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["discovery", "profile", id, "hosts"] }),
    onError: (err) => apiErrorToast(err),
  })
  const columns = useMemo(
    () =>
      buildInventoryScopeHostColumns({
        exemptAction: (h) =>
          canDo(h.kind === "device" ? "device" : "virtualmachine", "change") ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={exempt.isPending && exempt.variables.id === h.id}
              onClick={() => exempt.mutate(h)}
            >
              {h.scan_exempt ? "Include" : "Exempt"}
            </Button>
          ) : null,
      }),
    [canDo, exempt]
  )
  const rows = useMemo(() => q.data?.results ?? [], [q.data])
  const {
    rail,
    filteredRows,
    columns: wired,
  } = useUrlTableFilters(columns, rows)
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <EmptyState title="No hosts in scope">
        Add sites, prefixes, devices or VMs.
      </EmptyState>
    )
  return (
    <div className="flex min-w-0 overflow-hidden rounded-lg border border-border">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        {q.data?.truncated && (
          <p className="text-xs text-muted-foreground">
            Only the first 4,096 hosts are read.
          </p>
        )}
        <DataTable
          data={filteredRows}
          columns={wired}
          flexColumn="host"
          tableId="inventory-scope-hosts"
          searchable
          searchPlaceholder="Search hosts…"
          autoColumns={false}
        />
      </div>
    </div>
  )
}

function Runs({ id }: { id: string }) {
  const runs = useRuns(id)
  const columns = useMemo(
    () => buildInventoryRunColumns({ omit: ["profile"] }),
    []
  )
  if (runs.isLoading) return <Loading />
  if (runs.isError) return <QueryError error={runs.error} />
  const data = runs.data?.results ?? []
  if (data.length === 0) return <EmptyState title="No runs yet" />
  return (
    <DataTable
      data={data}
      total={runs.data?.count}
      columns={columns}
      flexColumn="run"
      tableId="inventory-runs"
      autoColumns={false}
    />
  )
}

function DeleteDialog({
  profile,
  onOpenChange,
  onDeleted,
}: {
  profile: InventoryProfile | null
  onOpenChange: (o: boolean) => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/discovery/profiles/${profile!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success(`Deleted ${profile!.name}`)
      qc.invalidateQueries({ queryKey: ["discovery", "profiles"] })
      onOpenChange(false)
      onDeleted()
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!profile} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {profile?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its runs go with it. Packages already read stay on their hosts.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
