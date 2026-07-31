import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { Download, KeyRound, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  AcmeOrder,
  CertificateRequest,
  Issuer,
  Paginated,
} from "@/lib/api"
import { FormSelect } from "@/components/forms"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/certificate-requests/$id")({
  component: RequestDetail,
})

const OBJECT_TYPE = "monitoring.certificaterequest"

const STATUS_VARIANT: Record<
  CertificateRequest["status"],
  "secondary" | "success" | "outline"
> = { generated: "secondary", issued: "success", cancelled: "outline" }

function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/x-pem-file" })
  )
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

function RequestDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["certificate-request", id],
    queryFn: () =>
      api<CertificateRequest>(`/api/monitoring/certificate-requests/${id}/`),
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
  return <Body req={q.data} />
}

function Body({ req }: { req: CertificateRequest }) {
  const [tab, setTab] = useUrlTab<"overview" | "acme" | "journal" | "history">(
    "overview"
  )
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [importOpen, setImportOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/certificate-requests/${req.id}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      toast.success("Request deleted")
      qc.invalidateQueries({ queryKey: ["certificate-requests"] })
      window.history.back()
    },
    onError: (err) => apiErrorToast(err),
  })

  const fetchKey = useMutation({
    mutationFn: () =>
      api<{ private_key: string }>(
        `/api/monitoring/certificate-requests/${req.id}/private-key/`
      ),
    onSuccess: (d) =>
      download(`${req.common_name || "request"}.key`, d.private_key),
    onError: (err) => apiErrorToast(err),
  })

  const subject: KvRow[] = [
    { label: "Common name", value: req.common_name },
    { label: "Organization", value: req.organization || dash },
    { label: "Org. unit", value: req.organizational_unit || dash },
    { label: "Country", value: req.country || dash },
    { label: "State", value: req.state || dash },
    { label: "Locality", value: req.locality || dash },
    {
      label: "SANs",
      value:
        req.san_dns.length || req.san_ip.length ? (
          <span className="flex flex-wrap gap-1">
            {[...req.san_dns, ...req.san_ip].map((s) => (
              <Badge key={s} variant="outline" className="text-[11px]">
                {s}
              </Badge>
            ))}
          </span>
        ) : (
          dash
        ),
    },
  ]

  const record: KvRow[] = [
    { label: "Key", value: req.key_spec_display },
    {
      label: "Status",
      value: (
        <Badge variant={STATUS_VARIANT[req.status]}>{req.status_display}</Badge>
      ),
    },
    {
      label: "Issued certificate",
      value: req.issued_certificate ? (
        <Link
          to="/certificates/$id"
          params={{ id: req.issued_certificate }}
          className="font-medium hover:underline"
        >
          {req.issued_certificate_subject_cn || "View certificate"}
        </Link>
      ) : (
        dash
      ),
    },
    { label: "Requested by", value: req.created_by_name || dash },
    { label: "Created", value: <TimeCell iso={req.created_at} /> },
  ]

  return (
    <DetailShell
      backTo="/certificate-requests"
      backLabel="Certificate requests"
      title={<span className="truncate">{req.common_name}</span>}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(`${req.common_name || "request"}.csr`, req.csr_pem)
            }
          >
            <Download className="h-3.5 w-3.5" /> CSR
          </Button>
          {canDo("certificaterequest", "change") && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={fetchKey.isPending}
                onClick={() => fetchKey.mutate()}
              >
                <KeyRound className="h-3.5 w-3.5" /> Private key
              </Button>
              {req.status !== "issued" && (
                <Button size="sm" onClick={() => setImportOpen(true)}>
                  <Upload className="h-3.5 w-3.5" /> Import issued
                </Button>
              )}
            </>
          )}
          {canDo("certificaterequest", "delete") && (
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
          title={req.common_name}
          badges={
            <Badge variant={STATUS_VARIANT[req.status]}>
              {req.status_display}
            </Badge>
          }
          statCols={2}
          stats={
            <>
              <DetailStat label="Key" value={req.key_spec_display} />
              <DetailStat
                label="SANs"
                value={
                  <span className="num">
                    {req.san_dns.length + req.san_ip.length}
                  </span>
                }
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "acme", label: "ACME" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Subject" rows={subject} />
          <KvCard title="Request" rows={record} />
        </div>
        <div className="mt-6">
          <KvCard
            title="CSR"
            rows={[
              {
                label: "PEM",
                value: (
                  <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]">
                    {req.csr_pem}
                  </pre>
                ),
              },
            ]}
          />
        </div>
      </DetailTab>
      <DetailTab value="acme">
        <AcmeTab req={req} canChange={canDo("certificaterequest", "change")} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={req.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={req.id} />
      </DetailTab>

      <ImportIssuedDialog
        req={req}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
      <Dialog open={deleting} onOpenChange={setDeleting}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete this request?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The request and its stored private key are removed. An issued
            certificate already imported into the inventory is kept.
          </p>
          <DialogFooter>
            <Button
              variant="ghost"
              type="button"
              onClick={() => setDeleting(false)}
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

const ORDER_VARIANT: Record<
  AcmeOrder["status"],
  "secondary" | "success" | "outline" | "destructive"
> = {
  pending: "secondary",
  ready: "secondary",
  processing: "secondary",
  valid: "success",
  invalid: "destructive",
  errored: "destructive",
}

function AcmeTab({
  req,
  canChange,
}: {
  req: CertificateRequest
  canChange: boolean
}) {
  const qc = useQueryClient()
  const [issuerId, setIssuerId] = useState<string | null>(null)
  const [challengeType, setChallengeType] = useState("dns-01")

  const issuersQ = useQuery({
    queryKey: ["issuers"],
    queryFn: () =>
      api<{ results: Issuer[] }>("/api/monitoring/issuers/?page_size=500"),
  })
  const ordersQ = useQuery({
    queryKey: ["acme-orders", req.id],
    queryFn: () =>
      api<Paginated<AcmeOrder>>(
        `/api/monitoring/acme-orders/?request=${req.id}`
      ),
    // Poll while an order is still working so the UI reflects the worker.
    refetchInterval: (query) => {
      const rows = query.state.data?.results ?? []
      return rows.some(
        (o) => o.status === "pending" || o.status === "processing"
      )
        ? 4000
        : false
    },
  })

  const issuers = (issuersQ.data?.results ?? []).filter((i) => i.enabled)
  const selected = issuers.find((i) => i.id === issuerId) ?? null
  const orders = ordersQ.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["acme-orders", req.id] })
    qc.invalidateQueries({ queryKey: ["certificate-request", req.id] })
  }

  const issueAuto = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/certificate-requests/${req.id}/acme-issue/`, {
        method: "POST",
        body: JSON.stringify({ issuer: issuerId }),
      }),
    onSuccess: () => {
      toast.success(
        "Issuing — the record is published and the order finalizes."
      )
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const createOrder = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/certificate-requests/${req.id}/acme-order/`, {
        method: "POST",
        body: JSON.stringify({
          issuer: issuerId,
          challenge_type: challengeType,
        }),
      }),
    onSuccess: () => {
      toast.success("Order opened — publish the record below, then finalize.")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <div className="space-y-6">
      {canChange && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">Issue via ACME</h3>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Request this certificate from a CA. With DNS-01 auto-publish,
            Danbyte publishes the challenge and finalizes automatically;
            otherwise it shows the record to publish, then you finalize.
          </p>
          {issuers.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No enabled issuers.{" "}
              <Link to="/certificate-issuers" className="underline">
                Add a certificate authority
              </Link>{" "}
              first.
            </p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <FormSelect
                label="Issuer"
                value={issuerId}
                onChange={setIssuerId}
                placeholder="Choose a CA…"
                options={issuers.map((i) => ({
                  value: i.id,
                  label: i.account_registered
                    ? i.name
                    : `${i.name} (no account)`,
                }))}
              />
              <FormSelect
                label="Challenge"
                value={challengeType}
                onChange={(v) => v && setChallengeType(v)}
                options={[
                  { value: "dns-01", label: "DNS-01" },
                  { value: "http-01", label: "HTTP-01" },
                ]}
              />
              <div className="flex gap-2 sm:col-span-2">
                {selected?.dns_provider ? (
                  <Button
                    size="sm"
                    disabled={!issuerId || issueAuto.isPending}
                    onClick={() => issueAuto.mutate()}
                  >
                    {issueAuto.isPending ? "Starting…" : "Issue automatically"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={!issuerId || createOrder.isPending}
                    onClick={() => createOrder.mutate()}
                  >
                    {createOrder.isPending ? "Opening…" : "Open order"}
                  </Button>
                )}
                {selected && !selected.account_registered && (
                  <span className="self-center text-[12px] text-amber-600 dark:text-amber-500">
                    Register this issuer's ACME account first.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold">Orders</h3>
        {orders.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">
            No ACME orders yet.
          </p>
        ) : (
          <div className="mt-2 space-y-3">
            {orders.map((o) => (
              <OrderCard
                key={o.id}
                order={o}
                reqId={req.id}
                canChange={canChange}
                onChanged={invalidate}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function OrderCard({
  order,
  reqId,
  canChange,
  onChanged,
}: {
  order: AcmeOrder
  reqId: string
  canChange: boolean
  onChanged: () => void
}) {
  const finalize = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/certificate-requests/${reqId}/acme-finalize/`, {
        method: "POST",
        body: JSON.stringify({ order: order.id }),
      }),
    onSuccess: () => {
      toast.success(
        "Finalizing — checking the challenge and downloading the cert."
      )
      onChanged()
    },
    onError: (e) => apiErrorToast(e),
  })
  const canFinalize =
    canChange && (order.status === "pending" || order.status === "ready")

  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={ORDER_VARIANT[order.status]}>
            {order.status_display}
          </Badge>
          <span className="text-[13px] text-muted-foreground">
            {order.issuer_name} · {order.challenge_type} ·{" "}
            <TimeCell iso={order.created_at} />
          </span>
        </div>
        {canFinalize && (
          <Button
            size="sm"
            variant="outline"
            disabled={finalize.isPending}
            onClick={() => finalize.mutate()}
          >
            {finalize.isPending ? "Finalizing…" : "Finalize"}
          </Button>
        )}
      </div>

      {order.issued_certificate && (
        <p className="mt-2 text-[13px]">
          Issued:{" "}
          <Link
            to="/certificates/$id"
            params={{ id: order.issued_certificate }}
            className="font-medium hover:underline"
          >
            {order.issued_certificate_subject_cn || "View certificate"}
          </Link>
        </p>
      )}

      {order.error && (
        <p className="mt-2 text-[12px] text-destructive">{order.error}</p>
      )}

      {order.challenges.length > 0 && order.status !== "valid" && (
        <div className="mt-3 space-y-2">
          <p className="text-[12px] font-medium text-muted-foreground">
            Publish to pass validation:
          </p>
          {order.challenges.map((c, i) => (
            <pre
              key={i}
              className="overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px]"
            >
              {c.type === "dns-01"
                ? `${c.record_name}  IN TXT  "${c.record_value}"`
                : `${c.path}\n${c.content}`}
            </pre>
          ))}
        </div>
      )}
    </div>
  )
}

function ImportIssuedDialog({
  req,
  open,
  onOpenChange,
}: {
  req: CertificateRequest
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [pem, setPem] = useState("")

  const imp = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/certificate-requests/${req.id}/import-issued/`, {
        method: "POST",
        body: JSON.stringify({ pem }),
      }),
    onSuccess: () => {
      toast.success("Issued certificate imported")
      qc.invalidateQueries({ queryKey: ["certificate-request", req.id] })
      qc.invalidateQueries({ queryKey: ["certificate-requests"] })
      qc.invalidateQueries({ queryKey: ["certificates"] })
      setPem("")
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setPem("")
        onOpenChange(o)
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Import the issued certificate</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Paste the CA-signed certificate for this request. Danbyte checks its
          public key matches the CSR, then adds it to the inventory and links it
          here.
        </p>
        <textarea
          value={pem}
          onChange={(e) => setPem(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={
            "-----BEGIN CERTIFICATE-----\nMIIC…\n-----END CERTIFICATE-----"
          }
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[12px] shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
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
            disabled={!pem.trim() || imp.isPending}
            onClick={() => imp.mutate()}
          >
            {imp.isPending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
