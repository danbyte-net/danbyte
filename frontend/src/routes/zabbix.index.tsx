import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  ZabbixConnection,
  ZabbixSyncResult,
  ZabbixTestResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { TimeCell } from "@/components/cells/time-ago"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ZabbixConnectionDialog } from "@/components/zabbix/connection-dialog"
import { ZabbixChanges } from "@/components/zabbix/changes"
import { ZabbixProvisionRules } from "@/components/zabbix/provision-rules"
import { ZabbixScopeList } from "@/components/zabbix/scope-list"
import { ZabbixLinkedHosts } from "@/components/zabbix/linked-hosts"
import { ZabbixMaintenanceList } from "@/components/zabbix/maintenance"
import { ZabbixAdoptionRules } from "@/components/zabbix/adoption-rules"

export const Route = createFileRoute("/zabbix/")({ component: ZabbixPage })

/**
 * The Zabbix integration's own page (#162).
 *
 * A main-nav page rather than a settings one, for the same reason the
 * virtualization sources have theirs: a connection is set up once, but the
 * review queue is worked - and the queue is the part somebody comes back to.
 *
 * Several connections are several servers; a strip picks which one the page
 * is about. One connection is the common case and the strip stays hidden.
 */
function ZabbixPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState<ZabbixConnection | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<ZabbixConnection | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const connections = useQuery({
    queryKey: ["zabbix-connections"],
    queryFn: () => api<Paginated<ZabbixConnection>>("/api/zabbix/connections/"),
  })
  const all = connections.data?.results ?? []
  const conn = all.find((c) => c.id === selectedId) ?? all.at(0)

  const test = useMutation({
    mutationFn: (id: string) =>
      api<ZabbixTestResult>(`/api/zabbix/connections/${id}/test/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      // A failed test is information, not an error - the detail says what is
      // wrong, and that is the whole point of pressing the button.
      if (r.ok) toast.success(r.detail)
      else toast.error(r.detail)
      void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const sync = useMutation({
    mutationFn: (id: string) =>
      api<ZabbixSyncResult>(`/api/zabbix/connections/${id}/sync/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      const proposed =
        r.create + r.update + r.template + r.prune + r.ambiguous + r.adopt
      toast.success(
        r.applied !== undefined
          ? `Applied ${r.applied}${r.failed ? `, ${r.failed} failed` : ""}.`
          : proposed === 0
            ? `Nothing to do - ${r.linked} of ${r.scoped} in scope already match.`
            : `${proposed} change${proposed === 1 ? "" : "s"} to review.`
      )
      // Matched by a rule but with no address to reach: a host cannot be
      // made for it, and silently scoping it out is how an operator concludes
      // the rule is broken.
      if (r.no_address) {
        toast.warning(
          `${r.no_address} matching device${r.no_address === 1 ? " has" : "s have"} no address - no host can be created for ${r.no_address === 1 ? "it" : "them"}.`
        )
      }
      // Zabbix's own words for what it refused. A count alone leaves the
      // operator with nothing to act on.
      for (const e of r.errors ?? []) {
        toast.error(`${e.device || "Host"}: ${e.detail}`)
      }
      void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-links"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-scope"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/zabbix/connections/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Connection removed")
      setDeleting(null)
      setSelectedId(null)
      void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const canManage = canDo("zabbixconnection", "change")
  const canAdd = canDo("zabbixconnection", "add")
  const canDelete = canDo("zabbixconnection", "delete")

  return (
    <ListPageShell
      title="Zabbix"
      count={connections.data ? all.length : undefined}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add connection
          </Button>
        )
      }
      query={connections}
    >
      {connections.data && !conn && (
        <EmptyState title="No Zabbix connection">
          Point Danbyte at a Zabbix frontend with a named API token.
        </EmptyState>
      )}

      {all.length > 1 && conn && (
        <SegmentedTabs
          value={conn.id}
          onValueChange={setSelectedId}
          items={all.map((c) => ({ value: c.id, label: c.name }))}
          className="mb-4"
        />
      )}

      {conn && (
        <div className="flex flex-col gap-6">
          <ConnectionCard
            conn={conn}
            canManage={canManage}
            canDelete={canDelete}
            testing={test.isPending}
            syncing={sync.isPending}
            onTest={() => test.mutate(conn.id)}
            onSync={() => sync.mutate(conn.id)}
            onEdit={() => setEditing(conn)}
            onDelete={() => setDeleting(conn)}
          />
          <ZabbixChanges
            connection={conn}
            onEditConnection={canManage ? () => setEditing(conn) : undefined}
          />
          <ZabbixProvisionRules connection={conn} canManage={canManage} />
          {conn.adopt_hosts && (
            <ZabbixAdoptionRules connection={conn} canManage={canManage} />
          )}
          <ZabbixScopeList connection={conn} />
          <ZabbixLinkedHosts connection={conn} canManage={canManage} />
          <ZabbixMaintenanceList connection={conn} canManage={canManage} />
        </div>
      )}

      <ZabbixConnectionDialog
        connection={editing}
        open={adding || editing !== null}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
        onSaved={() => {
          setAdding(false)
          setEditing(null)
          void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove ${deleting?.name ?? "this connection"}?`}
        description="Its rules, links and proposals go with it. Nothing in Zabbix is touched."
        confirmLabel="Remove"
        pendingLabel="Removing…"
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </ListPageShell>
  )
}

/** One server: what it is, what Danbyte may do to it, and where it is at. */
function ConnectionCard({
  conn,
  canManage,
  canDelete,
  testing,
  syncing,
  onTest,
  onSync,
  onEdit,
  onDelete,
}: {
  conn: ZabbixConnection
  canManage: boolean
  canDelete: boolean
  testing: boolean
  syncing: boolean
  onTest: () => void
  onSync: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const provisioningOff = conn.provision_mode === "off"

  const connection: KvRow[] = [
    {
      label: "Frontend",
      value: <span className="font-mono text-xs break-all">{conn.url}</span>,
    },
    {
      label: "Version",
      value: conn.version ? (
        <span className="inline-flex items-center gap-2">
          <Badge variant={conn.supported ? "success" : "warning"}>
            {conn.version}
          </Badge>
          {!conn.supported && (
            <span className="text-muted-foreground">
              below 6.0 - unsupported
            </span>
          )}
        </span>
      ) : (
        <Badge variant="secondary">Never tested</Badge>
      ),
    },
    {
      label: "API token",
      value: conn.token_set ? (
        <Badge variant="success">Set</Badge>
      ) : (
        <Badge variant="warning">Not set</Badge>
      ),
    },
    {
      label: "Engines",
      value: conn.engine_names.length ? (
        conn.engine_names.map((e) => e.name).join(", ")
      ) : (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="warning">None</Badge>
          <Link to="/monitoring-engines" className="link">
            Add a Zabbix engine, then link it here
          </Link>
        </span>
      ),
    },
    {
      label: "Last tested",
      value: conn.last_checked_at ? (
        <TimeCell iso={conn.last_checked_at} />
      ) : (
        dash
      ),
    },
    ...(conn.last_error
      ? [
          {
            label: "Last error",
            value: <Badge variant="destructive">{conn.last_error}</Badge>,
          },
        ]
      : []),
  ]

  const provisioning: KvRow[] = [
    {
      label: "Provisioning",
      value:
        conn.provision_mode === "off" ? (
          <Badge variant="secondary">Off</Badge>
        ) : conn.provision_mode === "review" ? (
          <Badge variant="info">Review</Badge>
        ) : (
          <Badge variant="success">Auto</Badge>
        ),
    },
    {
      label: "Sync automatically",
      value: provisioningOff
        ? dash
        : conn.auto_sync
          ? `Every ${conn.sync_interval_minutes} min`
          : "Off",
    },
    {
      label: "SNMP credentials",
      value: conn.send_snmp_credentials
        ? "Sent as secret macros"
        : "Kept in Danbyte",
    },
    {
      label: "Remove hosts",
      value: conn.prune_hosts
        ? `After ${conn.prune_after_days} days unwanted`
        : "Never",
    },
    {
      label: "Last sync",
      value: conn.last_sync_at ? <TimeCell iso={conn.last_sync_at} /> : dash,
    },
  ]

  const twoWay: KvRow[] = [
    {
      label: "Maintenance windows",
      value: conn.sync_maintenance ? (
        <Badge variant="success">Synced</Badge>
      ) : (
        <Badge variant="secondary">Off</Badge>
      ),
    },
    {
      label: "Last window sync",
      value: conn.last_maintenance_sync_at ? (
        <TimeCell iso={conn.last_maintenance_sync_at} />
      ) : (
        dash
      ),
    },
    {
      label: "Acknowledgements",
      value: conn.write_acknowledgements ? (
        <Badge variant="success">Written</Badge>
      ) : (
        <Badge variant="secondary">Off</Badge>
      ),
    },
    {
      label: "Host inventory",
      value: conn.read_inventory ? (
        <Badge variant="success">Read</Badge>
      ) : (
        <Badge variant="secondary">Off</Badge>
      ),
    },
    {
      label: "Adopt hosts",
      value: conn.adopt_hosts ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          <Badge variant="success">On</Badge>
          <span className="text-muted-foreground">
            {[
              conn.adopt_names.site,
              conn.adopt_names.role,
              conn.adopt_names.device_type,
            ]
              .filter(Boolean)
              .join(" · ") || "no defaults"}
          </span>
        </span>
      ) : (
        <Badge variant="secondary">Off</Badge>
      ),
    },
  ]

  const syncButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={syncing || provisioningOff}
      onClick={onSync}
    >
      <RefreshCw className="h-3.5 w-3.5" />
      {syncing ? "Syncing…" : "Sync"}
    </Button>
  )

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="inline-flex min-w-0 flex-1 items-center gap-2 text-sm font-semibold">
          {conn.name}
          {!conn.enabled && <Badge variant="secondary">Disabled</Badge>}
        </h2>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={testing}
              onClick={onTest}
            >
              {testing ? "Testing…" : "Test"}
            </Button>
            {provisioningOff ? (
              <Tooltip>
                {/* A disabled button takes no pointer events; the wrapper is
                    what the tooltip listens on. */}
                <TooltipTrigger asChild>
                  <span tabIndex={0}>{syncButton}</span>
                </TooltipTrigger>
                <TooltipContent variant="panel">
                  Provisioning is off - nothing to sync.
                </TooltipContent>
              </Tooltip>
            ) : (
              syncButton
            )}
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit
            </Button>
            {canDelete && (
              <Button size="sm" variant="ghost" onClick={onDelete}>
                Remove
              </Button>
            )}
          </div>
        )}
      </div>
      <div className="grid gap-4 p-4 lg:grid-cols-3">
        <KvCard title="Connection" rows={connection} />
        <KvCard title="Provisioning" rows={provisioning} />
        <KvCard title="Two-way" rows={twoWay} />
      </div>
    </section>
  )
}
