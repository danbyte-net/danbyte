import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { Download, Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Certificate,
  CertificateAssignment,
  CertificateBinding,
  Paginated,
} from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash, mono, CopyButton } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { EmptyState } from "@/components/empty-state"
import { DataTable } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormText } from "@/components/forms/text"
import { FormTextarea } from "@/components/forms/textarea"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import {
  ExpiryBadge,
  OriginBadge,
  fmtKey,
} from "@/components/columns/certificate-columns"
import { buildCertificateBindingColumns } from "@/components/columns/certificate-binding-columns"
import { buildCertificateAssignmentColumns } from "@/components/columns/certificate-assignment-columns"
import { CertificateObjectPicker } from "@/components/monitoring/certificate-object-picker"

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
    "overview" | "bindings" | "assignments" | "journal" | "history"
  >("overview")
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/certificates/${cert.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Certificate deleted")
      qc.invalidateQueries({ queryKey: ["certificates"] })
      window.history.back()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <DetailShell
      backTo="/certificates"
      backLabel="Certificates"
      title={
        <span className="truncate">
          {cert.name ||
            cert.subject_cn ||
            cert.subject ||
            cert.fingerprint_sha256.slice(0, 24)}
        </span>
      }
      presence={{ type: "certificate", id: cert.id }}
      actions={
        <>
          {canDo("certificate", "change") && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {canDo("certificate", "delete") && (
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
          title={cert.subject_cn || cert.subject || "Certificate"}
          badges={
            <span className="flex items-center gap-1.5">
              <OriginBadge cert={cert} />
              <ExpiryBadge cert={cert} />
            </span>
          }
          subtitle={
            <span className="font-mono">
              {cert.issuer_cn ? `Issued by ${cert.issuer_cn}` : cert.issuer}
            </span>
          }
          statCols={3}
          stats={
            <>
              <DetailStat
                label="Endpoints"
                value={<span className="num">{cert.binding_count}</span>}
              />
              <DetailStat
                label="Assigned to"
                value={<span className="num">{cert.assignment_count}</span>}
              />
              <DetailStat label="Key" value={fmtKey(cert)} />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "bindings", label: "Bindings", count: cert.binding_count },
        {
          value: "assignments",
          label: "Assignments",
          count: cert.assignment_count,
        },
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
      <DetailTab value="assignments">
        <AssignmentsTab cert={cert} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={cert.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={cert.id} />
      </DetailTab>

      <EditMetadataDialog
        cert={cert}
        open={editing}
        onOpenChange={setEditing}
      />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete this certificate?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The inventory row and its assignments are removed. If an endpoint is
            still serving this certificate, the next poll re-creates the
            observed row (identity is the fingerprint) — an uploaded-only row is
            gone.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDeleting(false)}
              type="button"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={del.isPending}
              onClick={() => del.mutate()}
            >
              {del.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DetailShell>
  )
}

/** Edit the only writable fields — the authored name and notes. Every
 * intrinsic fact is read-only (it comes from the DER bytes), so this touches
 * nothing else. */
function EditMetadataDialog({
  cert,
  open,
  onOpenChange,
}: {
  cert: Certificate
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(cert.name)
  const [notes, setNotes] = useState(cert.notes)

  const save = useMutation({
    mutationFn: () =>
      api<Certificate>(`/api/monitoring/certificates/${cert.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ name, notes }),
      }),
    onSuccess: () => {
      toast.success("Saved")
      qc.invalidateQueries({ queryKey: ["certificate", cert.id] })
      qc.invalidateQueries({ queryKey: ["certificates"] })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (o) {
          setName(cert.name)
          setNotes(cert.notes)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Edit certificate</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            placeholder="Optional label"
          />
          <FormTextarea
            label="Notes"
            value={notes}
            onChange={setNotes}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    { label: "Origin", value: <OriginBadge cert={cert} /> },
    { label: "Name", value: cert.name || dash },
    {
      label: "Notes",
      value: cert.notes ? (
        <span className="whitespace-pre-wrap">{cert.notes}</span>
      ) : (
        dash
      ),
    },
    { label: "First recorded", value: <TimeCell iso={cert.created_at} /> },
    { label: "Updated", value: <TimeCell iso={cert.updated_at} /> },
  ]

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <KvCard title="Identity" rows={identity} />
        <KvCard title="Validity" rows={validity} />
        <KvCard title="Key" rows={key} />
        <KvCard title="Record" rows={record} />
      </div>

      {cert.pem && <PemSection cert={cert} />}
    </div>
  )
}

/** The stored **public** PEM — present only for uploaded certificates. Scrolls
 * in its own box (a chain can be long and wide) with copy + download, matching
 * the config-context data-blob treatment. */
function PemSection({ cert }: { cert: Certificate }) {
  const download = () => {
    const blob = new Blob([cert.pem], { type: "application/x-pem-file" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${cert.subject_cn || cert.fingerprint_sha256.slice(0, 16)}.pem`
    a.click()
    URL.revokeObjectURL(url)
  }
  return (
    <section>
      <div className="mb-2 flex items-center gap-1.5">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Certificate (PEM)
        </h2>
        <CopyButton value={cert.pem} />
        <button
          type="button"
          onClick={download}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Download PEM"
        >
          <Download className="h-3 w-3" /> Download
        </button>
      </div>
      <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
        {cert.pem}
      </pre>
    </section>
  )
}

/** The objects declared to present this certificate (the source-of-truth
 * intent a drift check compares against), plus an "Assign to…" control. */
function AssignmentsTab({ cert }: { cert: Certificate }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canManage = canDo("certificateassignment", "add")
  const [deleting, setDeleting] = useState<CertificateAssignment | null>(null)

  const key = ["certificate-assignments", "by-cert", cert.id]
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<Paginated<CertificateAssignment>>(
        `/api/monitoring/certificate-assignments/?${new URLSearchParams({
          certificate: cert.id,
          page_size: "500",
        }).toString()}`
      ),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: key })
    qc.invalidateQueries({ queryKey: ["certificate", cert.id] })
  }

  const del = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/monitoring/certificate-assignments/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Assignment removed")
      setDeleting(null)
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const columns = useMemo<ColumnDef<CertificateAssignment>[]>(
    () =>
      buildCertificateAssignmentColumns({
        omit: ["certificate"],
        actions: canDo("certificateassignment", "delete")
          ? { onDelete: setDeleting, deleteLabel: "Unassign" }
          : undefined,
      }),
    [canDo]
  )

  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []

  return (
    <div className="space-y-4">
      {rows.length === 0 ? (
        <EmptyState title="Not assigned to anything.">
          Assign this certificate to a device, VM or IP to declare that the
          object should present it. An endpoint serving a different certificate
          then reads as drift.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          flexColumn="notes"
          tableId="certificate-assignments"
        />
      )}

      {canManage && (
        <CertificateObjectPicker certificateId={cert.id} onAssigned={refresh} />
      )}

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Remove this assignment?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The object will no longer be declared to present this certificate.
            Nothing observed changes — only the intent.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              type="button"
              disabled={del.isPending}
              onClick={() => deleting && del.mutate(deleting.id)}
            >
              {del.isPending ? "Removing…" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
