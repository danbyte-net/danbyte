import { useMemo, useState } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { Paginated, VulnException, VulnMatch } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { useUrlTab } from "@/lib/use-url-tab"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { DataTable } from "@/components/data-table"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { EmptyState } from "@/components/empty-state"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { RecordLink } from "@/components/columns/vulnerability-columns"
import {
  ExceptionSubject,
  ExpiryCell,
} from "@/components/columns/vulnerability-exception-columns"
import { buildVulnerabilityMatchColumns } from "@/components/columns/vulnerability-match-columns"
import {
  EXCEPTIONS_ENDPOINT,
  ExceptionDialog,
  useExceptionPerms,
} from "@/components/vulnerabilities/exception-dialog"
import {
  JUSTIFICATION_LABELS,
  RESPONSE_LABELS,
  SCOPE_LABELS,
  STATE_LABELS,
  STATUS_LABELS,
} from "@/components/vulnerabilities/exception-rules"
import { DeleteExceptionDialog } from "@/components/vulnerabilities/exceptions-table"
import { useVulnSettings } from "@/components/vulnerabilities/use-vuln-settings"

// One vulnerability exception (#451): the decision (Overview), the open
// matches it covers now (Covers) and its change log.

export const Route = createFileRoute("/vulnerabilities/exceptions/$id")({
  component: ExceptionDetail,
})

type Tab = "overview" | "covers" | "changelog"
const TABS: readonly Tab[] = ["overview", "covers", "changelog"]

function ExceptionDetail() {
  const { id } = Route.useParams()
  const settings = useVulnSettings()
  const q = useQuery({
    queryKey: ["vulnerability-exception", id],
    queryFn: () => api<VulnException>(`${EXCEPTIONS_ENDPOINT}${id}/`),
    enabled: settings.enabled,
  })
  if (settings.isLoading || (settings.enabled && q.isLoading))
    return <Loading />
  if (!settings.enabled)
    return (
      <div className="p-6">
        <EmptyState title="Vulnerability data is off" />
      </div>
    )
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body ex={q.data} />
}

function Body({ ex }: { ex: VulnException }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const { formatDateTime, today } = useDateFormat()
  const { canChange, canDelete } = useExceptionPerms()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const navigate = useNavigate()
  const title = ex.numid !== null ? `Exception #${ex.numid}` : "Exception"

  const decision: KvRow[] = [
    { label: "Record", value: <RecordLink id={ex.cve.vuln_id} /> },
    {
      label: "Status",
      value: <Badge variant="outline">{STATUS_LABELS[ex.status]}</Badge>,
    },
    { label: "Scope", value: SCOPE_LABELS[ex.scope] },
    { label: "Subject", value: <ExceptionSubject ex={ex} /> },
    { label: "Owner", value: ex.owner_name || dash },
    {
      label: "Expires",
      value: ex.expires_on ? (
        <ExpiryCell value={ex.expires_on} today={today} />
      ) : (
        "No expiry"
      ),
    },
    {
      label: "In force",
      value: ex.active ? (
        <Badge variant="success">Active</Badge>
      ) : (
        <Badge variant="destructive">Expired</Badge>
      ),
    },
    { label: "Covers", value: <span className="num">{ex.matches}</span> },
    {
      label: "Created",
      value: (
        <span>
          {formatDateTime(ex.created_at)}
          {ex.created_by && (
            <span className="text-muted-foreground">
              {" "}
              · {ex.created_by.display_name}
            </span>
          )}
        </span>
      ),
    },
  ]
  const analysis: KvRow[] = [
    { label: "State", value: STATE_LABELS[ex.analysis_state] ?? dash },
    {
      label: "Justification",
      value: ex.analysis_justification
        ? JUSTIFICATION_LABELS[ex.analysis_justification]
        : dash,
    },
    {
      label: "Response",
      value: ex.analysis_response.length
        ? ex.analysis_response.map((r) => RESPONSE_LABELS[r]).join(", ")
        : dash,
    },
    { label: "Record id", value: mono(ex.cve.vuln_id), copy: ex.cve.vuln_id },
  ]

  return (
    <DetailShell
      backTo="/vulnerabilities"
      backLabel="Vulnerabilities"
      title={title}
      actions={
        <>
          {canChange && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={title}
          badges={
            <>
              <Badge variant="outline">{STATUS_LABELS[ex.status]}</Badge>
              {!ex.active && <Badge variant="destructive">Expired</Badge>}
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "covers", label: "Covers", count: ex.matches },
        { value: "changelog", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <div className="space-y-4">
          <section>
            <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
              Reason
            </h2>
            <p className="max-w-3xl text-sm whitespace-pre-line">{ex.reason}</p>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <KvCard title="Exception" rows={decision} />
            <KvCard title="CycloneDX analysis" rows={analysis} />
          </div>
        </div>
      </DetailTab>
      <DetailTab value="covers">
        <Covers ex={ex} />
      </DetailTab>
      <DetailTab value="changelog">
        <ChangeLogPanel
          objectType="vulnerabilities.vulnerabilityexception"
          objectId={ex.id}
        />
      </DetailTab>
      <ExceptionDialog
        open={editing}
        onOpenChange={setEditing}
        exception={ex}
      />
      <DeleteExceptionDialog
        exception={deleting ? ex : null}
        onOpenChange={setDeleting}
        onDeleted={() =>
          void navigate({
            to: "/vulnerabilities",
            search: { view: "exceptions" } as never,
          })
        }
      />
    </DetailShell>
  )
}

/** The open matches this exception covers: the record's excepted matches
 * whose exception is this one. */
function Covers({ ex }: { ex: VulnException }) {
  const q = useQuery({
    queryKey: ["vulnerability-matches", "exception", ex.id],
    queryFn: () =>
      api<Paginated<VulnMatch>>(
        `/api/vulnerabilities/matches/?cve=${encodeURIComponent(ex.cve.vuln_id)}&excepted=true&page_size=1000`
      ),
  })
  const rows = useMemo(
    () => (q.data?.results ?? []).filter((m) => m.exception?.id === ex.id),
    [q.data, ex.id]
  )
  const columns = useMemo(
    () =>
      buildVulnerabilityMatchColumns({
        omit: [
          "record",
          "priority",
          "severity",
          "score",
          "kev",
          "epss",
          "summary",
          "excepted",
        ],
      }),
    []
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  if (rows.length === 0)
    return (
      <EmptyState title="Covers nothing open">
        {ex.active ? "No open match falls under it." : "It has expired."}
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="host"
      tableId="vulnerability-exception-matches"
      exportName="vulnerability-exception-matches"
      embedded
      autoColumns={false}
    />
  )
}
