import { createFileRoute } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"
import type { ColumnDef } from "@tanstack/react-table"

import { api } from "@/lib/api"
import type { Certificate, CertificateBinding, Paginated } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { ExpiryBadge, fmtKey } from "@/components/columns/certificate-columns"
import { buildCertificateBindingColumns } from "@/components/columns/certificate-binding-columns"

export const Route = createFileRoute("/certificates/$id")({
  component: CertificateDetail,
})

// app_label.model_name — matches the label registered in audit/apps.py
// ("monitoring.Certificate") and drives the Journal / History tabs.
const OBJECT_TYPE = "monitoring.certificate"

function CertificateDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["certificate", id],
    queryFn: () => api<Certificate>(`/api/monitoring/certificates/${id}/`),
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
  return <Body cert={q.data} />
}

function Body({ cert }: { cert: Certificate }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "bindings" | "journal" | "history"
  >("overview")

  return (
    <DetailShell
      backTo="/certificates"
      backLabel="Certificates"
      title={
        <span className="truncate">
          {cert.subject_cn ||
            cert.subject ||
            cert.fingerprint_sha256.slice(0, 24)}
        </span>
      }
      presence={{ type: "certificate", id: cert.id }}
      hero={
        <DetailHero
          title={cert.subject_cn || cert.subject || "Certificate"}
          badges={<ExpiryBadge cert={cert} />}
          subtitle={
            <span className="font-mono">
              {cert.issuer_cn ? `Issued by ${cert.issuer_cn}` : cert.issuer}
            </span>
          }
          statCols={2}
          stats={
            <>
              <DetailStat
                label="Endpoints"
                value={<span className="num">{cert.binding_count}</span>}
              />
              <DetailStat label="Key" value={fmtKey(cert)} />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "bindings", label: "Bindings", count: cert.binding_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <CertificateOverview cert={cert} />
      </DetailTab>
      <DetailTab value="bindings">
        <BindingsTab certificateId={cert.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={cert.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={cert.id} />
      </DetailTab>
    </DetailShell>
  )
}

/** A list of SAN entries rendered as monospace chips, or a dash. */
function SanList({ dns, ip }: { dns: string[]; ip: string[] }) {
  const all = [...dns, ...ip]
  if (all.length === 0) return dash
  return (
    <div className="flex flex-wrap gap-1">
      {all.map((s) => (
        <span
          key={s}
          className="rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px]"
        >
          {s}
        </span>
      ))}
    </div>
  )
}

function CertificateOverview({ cert }: { cert: Certificate }) {
  const identity: KvRow[] = [
    { label: "Subject", value: cert.subject || dash, copy: cert.subject },
    { label: "Subject CN", value: cert.subject_cn || dash },
    { label: "Issuer", value: cert.issuer || dash, copy: cert.issuer },
    { label: "Issuer CN", value: cert.issuer_cn || dash },
    { label: "Serial", value: mono(cert.serial), copy: cert.serial },
    {
      label: "Fingerprint (SHA-256)",
      value: (
        <span className="font-mono text-[11px] break-all">
          {cert.fingerprint_sha256}
        </span>
      ),
      copy: cert.fingerprint_sha256,
    },
    {
      label: "SANs",
      value: <SanList dns={cert.san_dns} ip={cert.san_ip} />,
    },
  ]

  const validity: KvRow[] = [
    { label: "Not before", value: <TimeCell iso={cert.not_before} /> },
    { label: "Not after", value: <TimeCell iso={cert.not_after} /> },
    { label: "Expiry", value: <ExpiryBadge cert={cert} /> },
    {
      label: "Last seen",
      value: cert.last_seen ? <TimeCell iso={cert.last_seen} /> : dash,
    },
  ]

  const key: KvRow[] = [
    { label: "Public key", value: fmtKey(cert) },
    {
      label: "Signature algorithm",
      value: cert.signature_algorithm || dash,
    },
    {
      label: "Trust",
      value: cert.self_signed ? (
        <Badge variant="outline">Self-signed</Badge>
      ) : (
        <span className="text-[13px]">CA-issued</span>
      ),
    },
  ]

  const record: KvRow[] = [
    { label: "First recorded", value: <TimeCell iso={cert.created_at} /> },
    { label: "Updated", value: <TimeCell iso={cert.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Identity" rows={identity} />
      <KvCard title="Validity" rows={validity} />
      <KvCard title="Key" rows={key} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

/** The endpoints that served this certificate — "what breaks when it
 * expires". Bindings are never deleted, so a stale `last_seen` is the signal
 * an endpoint stopped presenting it; an unverified chain is surfaced, not
 * hidden. */
function BindingsTab({ certificateId }: { certificateId: string }) {
  const q = useQuery({
    queryKey: ["certificate-bindings", certificateId],
    queryFn: () =>
      api<Paginated<CertificateBinding>>(
        `/api/monitoring/certificate-bindings/?${new URLSearchParams({
          certificate: certificateId,
          page_size: "500",
        }).toString()}`
      ),
  })
  const columns = useMemo<ColumnDef<CertificateBinding>[]>(
    () => buildCertificateBindingColumns(),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No endpoints on record.">
        No endpoint has been observed serving this certificate yet.
      </EmptyState>
    )
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="endpoint"
      tableId="certificate-bindings"
    />
  )
}
