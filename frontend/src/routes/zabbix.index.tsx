import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RefreshCw } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Paginated,
  ZabbixChange,
  ZabbixConnection,
  ZabbixHostLink,
  ZabbixSyncResult,
  ZabbixTestResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ListPageShell } from "@/components/list-page-shell"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { ZabbixConnectionDialog } from "@/components/zabbix/connection-dialog"
import { ZabbixChanges } from "@/components/zabbix/changes"
import { ZabbixTemplateRules } from "@/components/zabbix/template-rules"

export const Route = createFileRoute("/zabbix/")({ component: ZabbixPage })

/**
 * The Zabbix integration's own page (#162).
 *
 * A main-nav page rather than a settings one, for the same reason the
 * virtualization sources have theirs: a connection is set up once, but the
 * review queue is worked - and the queue is the part somebody comes back to.
 */
function ZabbixPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [editing, setEditing] = useState<ZabbixConnection | null>(null)
  const [adding, setAdding] = useState(false)

  const connections = useQuery({
    queryKey: ["zabbix-connections"],
    queryFn: () =>
      api<Paginated<ZabbixConnection>>("/api/zabbix/connections/"),
  })
  const conn = connections.data?.results[0]

  const changes = useQuery({
    queryKey: ["zabbix-changes", conn?.id],
    queryFn: () =>
      api<Paginated<ZabbixChange>>(
        `/api/zabbix/changes/?connection=${conn!.id}`
      ),
    enabled: !!conn,
  })
  const links = useQuery({
    queryKey: ["zabbix-links", conn?.id],
    queryFn: () =>
      api<Paginated<ZabbixHostLink>>(`/api/zabbix/links/?connection=${conn!.id}`),
    enabled: !!conn,
  })

  const test = useMutation({
    mutationFn: (id: string) =>
      api<ZabbixTestResult>(`/api/zabbix/connections/${id}/test/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      if (r.ok) toast.success(r.detail)
      else toast.error(r.detail)
      void qc.invalidateQueries({ queryKey: ["zabbix-connections"] })
    },
    // A failed test is information, not an error - the detail says what is
    // wrong, and that is the whole point of pressing the button.
    onError: (e) => apiErrorToast(e),
  })

  const sync = useMutation({
    mutationFn: (id: string) =>
      api<ZabbixSyncResult>(`/api/zabbix/connections/${id}/sync/`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      const proposed = r.create + r.update + r.template + r.prune + r.ambiguous
      toast.success(
        r.applied !== undefined
          ? `Applied ${r.applied}${r.failed ? `, ${r.failed} failed` : ""}.`
          : proposed === 0
            ? `Nothing to do - ${r.linked} of ${r.scoped} in scope already match.`
            : `${proposed} change${proposed === 1 ? "" : "s"} to review.`
      )
      // Zabbix's own words for what it refused. A count alone leaves the
      // operator with nothing to act on.
      for (const e of r.errors ?? []) {
        toast.error(`${e.device || "Host"}: ${e.detail}`)
      }
      void qc.invalidateQueries({ queryKey: ["zabbix-changes"] })
      void qc.invalidateQueries({ queryKey: ["zabbix-links"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const canManage = canDo("zabbixconnection", "change")

  return (
    <ListPageShell
      title="Zabbix"
      actions={
        canDo("zabbixconnection", "add") &&
        !conn && (
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="h-3.5 w-3.5" /> Add connection
          </Button>
        )
      }
      query={connections}
    >
      {connections.isError && <QueryError error={connections.error} />}

      {connections.data && !conn && (
        <EmptyState title="No Zabbix connection">
          Point Danbyte at your Zabbix frontend with a named API token, and an
          existing Zabbix can answer for a site&apos;s monitoring status.
        </EmptyState>
      )}

      {conn && (
        <div className="flex flex-col gap-6">
          <section className="rounded-lg border border-border bg-card">
            <div className="flex flex-wrap items-start gap-3 border-b border-border px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">{conn.name}</h2>
                  {conn.version ? (
                    <Badge variant={conn.supported ? "success" : "warning"}>
                      {conn.version}
                    </Badge>
                  ) : (
                    <Badge variant="secondary">never tested</Badge>
                  )}
                  {!conn.enabled && <Badge variant="secondary">disabled</Badge>}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {conn.api_url}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={test.isPending}
                  onClick={() => test.mutate(conn.id)}
                >
                  {test.isPending ? "Testing…" : "Test"}
                </Button>
                {canManage && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sync.isPending || conn.provision_mode === "off"}
                      onClick={() => sync.mutate(conn.id)}
                      title={
                        conn.provision_mode === "off"
                          ? "Provisioning is off - Danbyte writes nothing"
                          : undefined
                      }
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      {sync.isPending ? "Syncing…" : "Sync"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setEditing(conn)}
                    >
                      Edit
                    </Button>
                  </>
                )}
              </div>
            </div>

            <dl className="grid gap-x-8 gap-y-1.5 px-4 py-3 text-[13px] sm:grid-cols-2">
              <Row label="API token">
                {conn.token_set ? "set" : <Warn>not set</Warn>}
              </Row>
              <Row label="Provisioning">
                {conn.provision_mode === "off" ? (
                  <span className="text-muted-foreground">
                    Off - Danbyte writes nothing
                  </span>
                ) : conn.provision_mode === "review" ? (
                  "Review - proposes changes"
                ) : (
                  "Auto - applies changes"
                )}
              </Row>
              <Row label="SNMP credentials">
                {conn.send_snmp_credentials ? (
                  "Sent as secret macros"
                ) : (
                  <span className="text-muted-foreground">
                    Not sent - Danbyte keeps them
                  </span>
                )}
              </Row>
              <Row label="Remove hosts">
                {conn.prune_hosts
                  ? `After ${conn.prune_after_days} days unwanted`
                  : "No - kept"}
              </Row>
              <Row label="Automatic sync">
                {conn.provision_mode === "off" ? (
                  <span className="text-muted-foreground">-</span>
                ) : conn.auto_sync ? (
                  `Every ${conn.sync_interval_minutes} min`
                ) : (
                  <span className="text-muted-foreground">
                    Off - only when you press Sync
                  </span>
                )}
              </Row>
              <Row label="Last sync">
                {conn.last_sync_at ? (
                  <TimeCell iso={conn.last_sync_at} />
                ) : (
                  "never"
                )}
              </Row>
              <Row label="Last tested">
                {conn.last_checked_at ? (
                  <TimeCell iso={conn.last_checked_at} />
                ) : (
                  "never"
                )}
              </Row>
              {conn.last_error && (
                <div className="sm:col-span-2">
                  <Warn>{conn.last_error}</Warn>
                </div>
              )}
            </dl>
          </section>

          <ZabbixChanges
            connection={conn}
            changes={changes.data?.results ?? []}
            loading={changes.isLoading}
          />

          <ZabbixTemplateRules connection={conn} canManage={canManage} />

          <section className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">
                Linked hosts{" "}
                <span className="num text-xs font-normal text-muted-foreground">
                  {links.data?.results.length ?? 0}
                </span>
              </h2>
            </div>
            {(links.data?.results.length ?? 0) === 0 ? (
              <p className="px-4 py-3 text-[13px] text-muted-foreground">
                Nothing paired yet. A device gets linked the first time a sync
                pass matches it to a Zabbix host.
              </p>
            ) : (
              <div className="divide-y divide-border">
                {links.data!.results.map((l) => (
                  <div
                    key={l.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]"
                  >
                    <span className="min-w-0 flex-1">
                      {l.device ? (
                        <Link
                          to="/devices/$id"
                          params={{ id: l.device.id }}
                          className="link"
                        >
                          {l.device.name}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                      <span className="text-muted-foreground"> → </span>
                      <span className="font-mono text-xs">{l.host_name}</span>
                    </span>
                    <Badge variant="secondary">matched by {l.matched_by}</Badge>
                    {l.created_here && (
                      <Badge variant="secondary">Danbyte created</Badge>
                    )}
                    {l.unwanted_since && (
                      <Badge variant="warning">
                        unwanted since <TimeCell iso={l.unwanted_since} />
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
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
    </ListPageShell>
  )
}

function Row({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-32 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function Warn({ children }: { children: React.ReactNode }) {
  return <span className="text-amber-700 dark:text-amber-500">{children}</span>
}
