import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { ExternalLink, Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { useUrlTab } from "@/lib/use-url-tab"
import { api } from "@/lib/api"
import type { AutomationTarget, DeployRun, Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { buildDeployRunColumns } from "@/components/columns/deploy-run-columns"
import { AutomationTargetDeleteDialog } from "@/components/automation-target-delete-dialog"
import { AutomationTargetTestButton } from "@/components/automation-target-test-button"
import { useMe } from "@/lib/use-me"

const OBJECT_TYPE = "integrations.automationtarget"

type Tab = "overview" | "runs" | "journal" | "history"
const TABS: readonly Tab[] = ["overview", "runs", "journal", "history"]

export const Route = createFileRoute("/automation-targets/$id")({
  component: AutomationTargetDetail,
})

function AutomationTargetDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["automation-target", id],
    queryFn: () => api<AutomationTarget>(`/api/automation-targets/${id}/`),
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
  return <Body target={q.data} />
}

function Body({ target: t }: { target: AutomationTarget }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<AutomationTarget | null>(null)
  const goBack = useCallback(() => nav({ to: "/automation-targets" }), [nav])

  // Hoisted so the hero + tab strip carry the run count. `TargetRuns` reads the
  // same query key, so react-query serves it from cache - one request, not two.
  const runs = useTargetRuns(t.id)

  return (
    <DetailShell
      backTo="/automation-targets"
      backLabel="Automation targets"
      title={t.name}
      presence={{ type: "automationtarget", id: t.id }}
      actions={
        <>
          <AutomationTargetTestButton target={t} variant="button" />
          {canDo("automationtarget", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/automation-targets/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("automationtarget", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(t)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={t.name}
          badges={
            <>
              <Badge variant="outline" className="text-[10px]">
                {t.kind_display}
              </Badge>
              <Badge
                variant={t.enabled ? "success" : "secondary"}
                className="text-[10px]"
              >
                {t.enabled ? "enabled" : "disabled"}
              </Badge>
              {t.auto_on_change && (
                <Badge variant="secondary" className="text-[10px]">
                  auto on change
                </Badge>
              )}
            </>
          }
          subtitle={<span className="font-mono text-[12px]">{t.base_url}</span>}
          statCols={1}
          stats={
            <DetailStat
              label="Runs"
              value={
                <span className="num">{runs.data ? runs.data.count : "-"}</span>
              }
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "runs", label: "Runs", count: runs.data?.count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <TargetOverview target={t} />
      </DetailTab>
      <DetailTab value="runs">
        <TargetRuns targetId={t.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={t.id} />
      </DetailTab>

      <AutomationTargetDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function yesNo(v: boolean) {
  return (
    <Badge variant={v ? "success" : "secondary"} className="text-[10px]">
      {v ? "yes" : "no"}
    </Badge>
  )
}

function TargetOverview({ target: t }: { target: AutomationTarget }) {
  const extraVarKeys = Object.keys(t.extra_vars)

  // The stored token/signing secret is write-only on the API (the serializer
  // only ever returns `token_set`), so this page can say whether one exists and
  // nothing more.
  const dispatch: KvRow[] = [
    {
      label: "Kind",
      value: (
        <span>
          {t.kind_display}{" "}
          <span className="font-mono text-[11px] text-muted-foreground">
            ({t.kind})
          </span>
        </span>
      ),
    },
    { label: "Enabled", value: yesNo(t.enabled) },
    {
      label: "Endpoint",
      value: (
        <a
          href={t.base_url}
          target="_blank"
          rel="noreferrer"
          className="link inline-flex items-center gap-1 font-mono text-[12px]"
        >
          <ExternalLink className="h-3.5 w-3.5 shrink-0" />
          <span className="break-all">{t.base_url}</span>
        </a>
      ),
      copy: t.base_url || undefined,
    },
    ...(t.kind === "awx"
      ? [
          {
            label: "Job template",
            value: t.job_template_id ? (
              <span className="font-mono text-[13px]">{t.job_template_id}</span>
            ) : (
              dash
            ),
            copy: t.job_template_id || undefined,
          } satisfies KvRow,
        ]
      : []),
    { label: "Verify TLS", value: yesNo(t.ssl_verify) },
    {
      label: "Credential",
      value: t.token_set ? (
        <Badge variant="secondary" className="text-[10px]">
          stored
        </Badge>
      ) : (
        <span className="text-muted-foreground">not set</span>
      ),
    },
  ]

  const scope: KvRow[] = [
    { label: "Auto-deploy on change", value: yesNo(t.auto_on_change) },
    {
      label: "Object types",
      value: t.object_types.length ? (
        <span className="flex flex-wrap gap-1">
          {t.object_types.map((o) => (
            <Badge key={o} variant="outline" className="text-[10px]">
              {o}
            </Badge>
          ))}
        </span>
      ) : (
        <span className="text-muted-foreground">device (default)</span>
      ),
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={t.created_at} /> },
    { label: "Updated", value: <TimeCell iso={t.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Dispatch" rows={dispatch} />
        <KvCard title="Triggering" rows={scope} />
        <KvCard title="Record" rows={record} />
      </div>
      {extraVarKeys.length > 0 && (
        <section>
          <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Extra vars
          </h2>
          <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
            {JSON.stringify(t.extra_vars, null, 2)}
          </pre>
        </section>
      )}
    </div>
  )
}

function useTargetRuns(targetId: string) {
  return useQuery({
    queryKey: ["deploy-runs", "by-target", targetId],
    queryFn: () =>
      api<Paginated<DeployRun>>(
        `/api/deploy-runs/?target=${targetId}&page_size=100`
      ),
    refetchInterval: 30_000,
  })
}

/** Every dispatch Danbyte handed to this runner, newest first. */
function TargetRuns({ targetId }: { targetId: string }) {
  const query = useTargetRuns(targetId)
  const columns = useMemo(() => buildDeployRunColumns({ omit: ["target"] }), [])
  if (query.isError) return <QueryError error={query.error} />
  if (query.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = query.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No deploy runs for this target yet.">
        Deploy a device from its Config tab, or turn on{" "}
        <span className="font-medium">Auto-deploy on change</span> for this
        target.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="detail"
      tableId="embedded-deploy-runs"
    />
  )
}
