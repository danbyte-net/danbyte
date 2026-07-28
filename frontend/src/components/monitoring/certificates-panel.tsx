import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { GitCompareArrows, Plus, Upload, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Certificate, CertificateAssignment, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { Combobox } from "@/components/ui/combobox"
import type { ComboboxOption } from "@/components/ui/combobox"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"
import {
  ExpiryBadge,
  OriginBadge,
} from "@/components/columns/certificate-columns"
import { UploadCertificateDialog } from "@/components/monitoring/upload-certificate-dialog"

// One firing cert_mismatch alert (kind=tls_cert, detail.drift="cert_mismatch"):
// the endpoint is serving a certificate other than the one its object was
// declared to present. detail.binding_id is what accept-served repoints.
interface CertMismatchDetail {
  drift?: string
  endpoint?: string
  binding_id?: string
  served_subject_cn?: string | null
  served_fingerprint_sha256?: string
  assigned?: { object_type: string; object_id: string }[]
}
interface RawAlert {
  id: string
  kind: string
  status: string
  detail: CertMismatchDetail | null
}

/**
 * The source-of-truth certificate view on one object (device / VM / IP). Lists
 * the certificates the object is **declared** to present (its assignments),
 * flags **drift** when an endpoint is serving something else (cert_mismatch)
 * with an Accept-served action, and lets an operator assign an existing
 * certificate or upload a new one. Drop into any detail page — it resolves
 * everything from the `(object_type, object_id)` pair, exactly like the
 * cert-drift engine does server-side.
 */
export function CertificatesPanel({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAssign = canDo("certificateassignment", "add")
  const canUnassign = canDo("certificateassignment", "delete")

  const [pick, setPick] = useState<string | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)

  const assignmentsKey = ["certificate-assignments", objectType, objectId]
  const assignments = useQuery({
    queryKey: assignmentsKey,
    queryFn: () =>
      api<Paginated<CertificateAssignment>>(
        `/api/monitoring/certificate-assignments/?${new URLSearchParams({
          object_type: objectType,
          object_id: objectId,
          page_size: "500",
        }).toString()}`
      ),
  })

  // The tenant's certificates — for the assign picker AND to enrich each
  // assignment row with the full cert (server-derived expiry/origin), so a
  // stale row can't read itself healthy and origin shows without a per-row fetch.
  const certs = useQuery({
    queryKey: ["certificates", "picker"],
    queryFn: () =>
      api<Paginated<Certificate>>(
        "/api/monitoring/certificates/?page_size=500"
      ),
    staleTime: 60_000,
  })
  const certById = useMemo(() => {
    const m = new Map<string, Certificate>()
    for (const c of certs.data?.results ?? []) m.set(c.id, c)
    return m
  }, [certs.data])

  // Firing cert_mismatch drift concerning THIS object — matched by the alert's
  // declared assignments (the engine records which assignment it compared).
  const alerts = useQuery({
    queryKey: ["alerts", "firing", "cert-mismatch"],
    queryFn: () =>
      api<{ results: RawAlert[] }>("/api/monitoring/alerts/?status=firing"),
    staleTime: 30_000,
  })
  const mismatches = useMemo(() => {
    const rows = alerts.data?.results ?? []
    return rows.filter(
      (a) =>
        a.kind === "tls_cert" &&
        a.detail?.drift === "cert_mismatch" &&
        (a.detail.assigned ?? []).some(
          (x) => x.object_type === objectType && x.object_id === objectId
        )
    )
  }, [alerts.data, objectType, objectId])

  const refresh = () => {
    qc.invalidateQueries({ queryKey: assignmentsKey })
    qc.invalidateQueries({ queryKey: ["certificates"] })
    qc.invalidateQueries({ queryKey: ["alerts", "firing", "cert-mismatch"] })
  }

  const assign = useMutation({
    mutationFn: (certificate: string) =>
      api("/api/monitoring/certificate-assignments/", {
        method: "POST",
        body: JSON.stringify({
          certificate,
          object_type: objectType,
          object_id: objectId,
          notes: "",
        }),
      }),
    onSuccess: () => {
      toast.success("Certificate assigned")
      setPick(null)
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const unassign = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/api/monitoring/certificate-assignments/${id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Certificate unassigned")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const acceptServed = useMutation({
    mutationFn: (binding: string) =>
      api("/api/monitoring/certificate-assignments/accept-served/", {
        method: "POST",
        body: JSON.stringify({ binding }),
      }),
    onSuccess: () => {
      toast.success("Accepted the served certificate")
      refresh()
    },
    onError: (err) => apiErrorToast(err),
  })

  const rows = assignments.data?.results ?? []
  const assignedIds = useMemo(
    () => new Set(rows.map((a) => a.certificate)),
    [rows]
  )

  // Picker options: certificates not already assigned to this object.
  const options = useMemo<ComboboxOption[]>(
    () =>
      (certs.data?.results ?? [])
        .filter((c) => !assignedIds.has(c.id))
        .map((c) => ({
          value: c.id,
          label:
            c.name ||
            c.subject_cn ||
            c.subject ||
            `${c.fingerprint_sha256.slice(0, 16)}…`,
        })),
    [certs.data, assignedIds]
  )

  const columns: SimpleColumn<CertificateAssignment>[] = [
    {
      id: "certificate",
      header: "Certificate",
      cell: (a) => (
        <Link
          to="/certificates/$id"
          params={{ id: a.certificate }}
          className="font-medium text-primary hover:underline"
        >
          {a.certificate_subject_cn ||
            `${(a.certificate_fingerprint ?? "").slice(0, 16)}…`}
        </Link>
      ),
    },
    {
      id: "origin",
      header: "Origin",
      cell: (a) => {
        const c = certById.get(a.certificate)
        return c ? <OriginBadge cert={c} /> : dash
      },
    },
    {
      id: "expiry",
      header: "Expiry",
      cell: (a) => {
        const c = certById.get(a.certificate)
        return c ? (
          <ExpiryBadge cert={c} />
        ) : a.certificate_not_after ? (
          <TimeCell iso={a.certificate_not_after} />
        ) : (
          dash
        )
      },
    },
    {
      id: "notes",
      header: "Notes",
      flex: true,
      cell: (a) =>
        a.notes ? (
          <span className="text-xs">{a.notes}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      align: "right",
      cell: (a) =>
        canUnassign ? (
          <button
            type="button"
            onClick={() => unassign.mutate(a.id)}
            disabled={unassign.isPending}
            className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-destructive"
            aria-label="Unassign certificate"
            title="Unassign certificate"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null,
    },
  ]

  return (
    <Section title="Certificates" count={rows.length}>
      <div className="max-w-3xl space-y-3">
        {assignments.isError && <QueryError error={assignments.error} />}

        {/* Drift: the endpoint is serving a certificate other than the one this
            object was declared to present. Amber, compare-arrows — the same
            vocabulary as SNMP drift; accepting repoints intent at reality. */}
        {mismatches.map((m) => (
          <div
            key={m.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-amber-50 px-3 py-2 text-xs ring-1 ring-amber-600/20 ring-inset dark:bg-amber-950/40 dark:ring-amber-400/20"
          >
            <GitCompareArrows className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="text-amber-800 dark:text-amber-200">
              <span className="font-medium">{m.detail?.endpoint}</span> is
              serving{" "}
              <span className="font-medium">
                {m.detail?.served_subject_cn ||
                  `${(m.detail?.served_fingerprint_sha256 ?? "").slice(0, 16)}…`}
              </span>
              , which is not assigned here.
            </span>
            {canAssign && m.detail?.binding_id && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="ml-auto h-7"
                disabled={acceptServed.isPending}
                onClick={() => acceptServed.mutate(m.detail!.binding_id!)}
              >
                Accept served
              </Button>
            )}
          </div>
        ))}

        <SimpleTable
          columns={columns}
          data={rows}
          getRowKey={(a) => a.id}
          empty="No certificates assigned. Assign one to declare what this object should present."
        />

        {canAssign && (
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-50 flex-1">
              <Combobox
                value={pick}
                onChange={setPick}
                options={options}
                placeholder="Assign a certificate…"
                searchPlaceholder="Search certificates…"
                emptyText="No unassigned certificates."
              />
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!pick || assign.isPending}
              onClick={() => pick && assign.mutate(pick)}
            >
              <Plus className="h-3.5 w-3.5" /> Assign
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setUploadOpen(true)}
            >
              <Upload className="h-3.5 w-3.5" /> Upload
            </Button>
          </div>
        )}
      </div>

      <UploadCertificateDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        onUploaded={(cert) => assign.mutate(cert.id)}
      />
    </Section>
  )
}
