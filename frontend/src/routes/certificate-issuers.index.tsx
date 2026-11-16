import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { Plus } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DnsProvider, Issuer, Paginated } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { buildIssuerColumns } from "@/components/columns/issuer-columns"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useUrlTableFilters } from "@/components/table-filters"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCheckbox,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export const Route = createFileRoute("/certificate-issuers/")({
  component: IssuersPage,
})

function IssuersPage() {
  const { canDo } = useMe()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Issuer | null>(null)
  const [deleting, setDeleting] = useState<Issuer | null>(null)
  const [selected, setSelected] = useState<Issuer[]>([])

  const query = useQuery({
    queryKey: ["issuers"],
    queryFn: () =>
      api<Paginated<Issuer>>("/api/monitoring/issuers/?page_size=500"),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const canManage = canDo("issuer", "change")
  const canDelete = canDo("issuer", "delete")
  const selectable = canManage || canDelete

  const columns = useMemo(
    () =>
      buildIssuerColumns<Issuer>({
        selection: selectable,
        onOpen: (r) => {
          setEditing(r)
          setFormOpen(true)
        },
        actions: {
          extra: (r) => (canManage ? <RegisterButton issuer={r} /> : null),
          onEdit: (r) => {
            setEditing(r)
            setFormOpen(true)
          },
          canEdit: () => canManage,
          onDelete: setDeleting,
          canDelete: () => canDelete,
          deleteLabel: "Delete issuer",
        },
      }),
    [canManage, canDelete, selectable]
  )
  const {
    rail,
    filteredRows,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Certificate authorities"
      count={query.data ? filteredRows.length : undefined}
      rail={rows.length > 0 ? rail : undefined}
      actions={
        canDo("issuer", "add") ? (
          <Button
            size="sm"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Add issuer
          </Button>
        ) : undefined
      }
      query={query}
    >
      {rows.length === 0 ? (
        <EmptyState title="No issuers yet.">
          Add an ACME issuer (a directory URL) to request and auto-renew
          certificates. Requires a secret store to be enabled (Settings →
          Security).
        </EmptyState>
      ) : (
        <DataTable
          data={filteredRows}
          columns={wiredColumns}
          flexColumn="directory_url"
          tableId="certificate-issuers"
          onSelectedRowsChange={selectable ? setSelected : undefined}
          selectedRows={selectable ? selected : undefined}
        />
      )}
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/monitoring/issuers/"
        noun={["issuer", "issuers"]}
        invalidate={[["issuers"]]}
        onCleared={() => setSelected([])}
        canEdit={canManage}
        canDelete={canDelete}
        ioType="issuer"
      />
      <IssuerFormDialog
        key={editing?.id ?? "new"}
        issuer={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
      />
      <IssuerDeleteDialog
        issuer={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function RegisterButton({ issuer }: { issuer: Issuer }) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api(`/api/monitoring/issuers/${issuer.id}/register-account/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: () => {
      toast.success("ACME account registered")
      qc.invalidateQueries({ queryKey: ["issuers"] })
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={m.isPending}
      onClick={() => m.mutate()}
    >
      {m.isPending
        ? "Registering…"
        : issuer.account_registered
          ? "Re-register"
          : "Register account"}
    </Button>
  )
}

function IssuerDeleteDialog({
  issuer,
  onOpenChange,
}: {
  issuer: Issuer | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: (i: Issuer) =>
      api<void>(`/api/monitoring/issuers/${i.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Issuer deleted")
      qc.invalidateQueries({ queryKey: ["issuers"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open={!!issuer} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete “{issuer?.name}”?</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          The issuer and its stored ACME account key are removed. Certificates
          it already issued are kept.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={m.isPending}
            onClick={() => issuer && m.mutate(issuer)}
          >
            {m.isPending ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function IssuerFormDialog({
  issuer,
  open,
  onOpenChange,
}: {
  issuer: Issuer | null
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(issuer?.name ?? "")
  const [directoryUrl, setDirectoryUrl] = useState(issuer?.directory_url ?? "")
  const [contactEmail, setContactEmail] = useState(issuer?.contact_email ?? "")
  const [verifyTls, setVerifyTls] = useState(issuer?.verify_tls ?? true)
  const [caCertificate, setCaCertificate] = useState(
    issuer?.ca_certificate ?? ""
  )
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [enabled, setEnabled] = useState(issuer?.enabled ?? true)
  const [eabKid, setEabKid] = useState(issuer?.eab_kid ?? "")
  const [eabHmac, setEabHmac] = useState("")
  const [dnsProvider, setDnsProvider] = useState<DnsProvider>(
    issuer?.dns_provider ?? ""
  )
  const s = issuer?.dns_settings ?? {}
  const [server, setServer] = useState(String(s.server ?? ""))
  const [zone, setZone] = useState(String(s.zone ?? ""))
  const [keyName, setKeyName] = useState(String(s.key_name ?? ""))
  const [keyAlgorithm, setKeyAlgorithm] = useState(
    String(s.key_algorithm ?? "hmac-sha256")
  )
  const [clientPrincipal, setClientPrincipal] = useState(
    String(s.client_principal ?? "")
  )
  const [keytab, setKeytab] = useState(String(s.keytab ?? ""))
  const [tsigSecret, setTsigSecret] = useState("")

  const save = useMutation({
    mutationFn: () => {
      const dns_settings: Record<string, string> = {}
      if (dnsProvider === "rfc2136") {
        Object.assign(dns_settings, {
          server,
          zone,
          key_name: keyName,
          key_algorithm: keyAlgorithm,
        })
      } else if (dnsProvider === "gss-tsig") {
        Object.assign(dns_settings, {
          server,
          zone,
          client_principal: clientPrincipal,
          keytab,
        })
      }
      const body: Record<string, unknown> = {
        name,
        directory_url: directoryUrl,
        contact_email: contactEmail,
        verify_tls: verifyTls,
        ca_certificate: caCertificate,
        enabled,
        eab_kid: eabKid,
        dns_provider: dnsProvider,
        dns_settings,
      }
      if (eabHmac) body.eab_hmac = eabHmac
      if (tsigSecret) body.tsig_secret = tsigSecret
      return issuer
        ? api(`/api/monitoring/issuers/${issuer.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/monitoring/issuers/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      reset()
      toast.success(issuer ? "Issuer saved" : "Issuer created")
      qc.invalidateQueries({ queryKey: ["issuers"] })
      onOpenChange(false)
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{issuer ? "Edit issuer" : "Add issuer"}</DialogTitle>
        </DialogHeader>
        <div className="grid max-h-[70vh] gap-3 overflow-y-auto pr-1">
          <FormText label="Name" value={name} onChange={setName} required />
          <FormText
            label="Directory URL"
            value={directoryUrl}
            onChange={setDirectoryUrl}
            type="url"
            placeholder="https://acme-v02.api.letsencrypt.org/directory"
            error={fieldErrors.directory_url}
            required
          />
          <FormText
            label="Contact email"
            value={contactEmail}
            onChange={setContactEmail}
            type="email"
          />
          <FormCheckbox
            label="Verify the CA's TLS certificate"
            checked={verifyTls}
            onChange={setVerifyTls}
            hint="Keep on. For a private CA, paste its root under CA certificate instead."
          />
          {verifyTls && (
            <>
              <FormTextarea
                label="CA certificate"
                value={caCertificate}
                onChange={setCaCertificate}
                rows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                error={fieldErrors.ca_certificate}
                info="The root that signs the CA's TLS certificate, in PEM - for step-ca, its root_ca.crt. Trusted for this issuer in addition to the server's trust store, never instead of it. Leave empty for a public CA or a root already in the server's store."
              />
              {issuer && issuer.ca_certificate_info.length > 0 && (
                <StoredCaCertificates issuer={issuer} />
              )}
            </>
          )}
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />
          <FormText
            label="EAB key id"
            value={eabKid}
            onChange={setEabKid}
            info="External Account Binding - only if the CA requires it (some public CAs, e.g. ZeroSSL)."
          />
          {eabKid && (
            <FormText
              label="EAB HMAC key"
              value={eabHmac}
              onChange={setEabHmac}
              type="password"
              hint={
                issuer?.eab_hmac_set ? "set - blank keeps current" : undefined
              }
            />
          )}
          <FormSelect
            label="DNS-01 auto-publish"
            value={dnsProvider || null}
            onChange={(v) => setDnsProvider((v as DnsProvider) ?? "")}
            noneLabel="Manual"
            info={
              <>
                How the DNS-01 challenge TXT record gets published.{" "}
                <b>Manual</b> shows you the record to add yourself.{" "}
                <b>RFC2136</b> works with BIND/Samba/PowerDNS/Knot.{" "}
                <b>GSS-TSIG</b> is for Windows AD DNS (needs a keytab).
              </>
            }
            options={[
              { value: "rfc2136", label: "RFC2136 / TSIG" },
              { value: "gss-tsig", label: "Windows AD (GSS-TSIG)" },
            ]}
          />
          {dnsProvider === "rfc2136" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <FormText
                label="DNS server"
                value={server}
                onChange={setServer}
              />
              <FormText
                label="Zone"
                value={zone}
                onChange={setZone}
                placeholder="example.com"
              />
              <FormText
                label="TSIG key name"
                value={keyName}
                onChange={setKeyName}
              />
              <FormText
                label="TSIG algorithm"
                value={keyAlgorithm}
                onChange={setKeyAlgorithm}
                placeholder="hmac-sha256"
              />
              <FormText
                label="TSIG secret"
                value={tsigSecret}
                onChange={setTsigSecret}
                type="password"
                hint={
                  issuer?.tsig_secret_set
                    ? "set - blank keeps current"
                    : undefined
                }
              />
            </div>
          )}
          {dnsProvider === "gss-tsig" && (
            <div className="grid gap-3 rounded-md border border-border p-3">
              <FormText
                label="DNS server (FQDN)"
                value={server}
                onChange={setServer}
                placeholder="dc01.example.com"
              />
              <FormText
                label="Zone"
                value={zone}
                onChange={setZone}
                placeholder="example.com"
              />
              <FormText
                label="Client principal"
                value={clientPrincipal}
                onChange={setClientPrincipal}
                placeholder="svc-dns@EXAMPLE.COM"
              />
              <FormText
                label="Keytab path"
                value={keytab}
                onChange={setKeytab}
                placeholder="/etc/danbyte/dns.keytab"
                info="Path on the Danbyte host to the service account's Kerberos keytab. Needs the gssapi package installed."
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || !directoryUrl.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : issuer ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StoredCaCertificates({ issuer }: { issuer: Issuer }) {
  const { formatDate } = useDateFormat()
  return (
    <ul className="-mt-1 grid gap-1 text-[12px] text-muted-foreground">
      {issuer.ca_certificate_info.map((c) => (
        <li
          key={c.fingerprint_sha256}
          className="flex min-w-0 items-center gap-2"
        >
          <span className="truncate text-foreground">
            {c.subject_cn || c.subject}
          </span>
          <span className="shrink-0 whitespace-nowrap">
            expires {formatDate(c.not_after)}
          </span>
          {c.days_left <= 30 && (
            <Badge variant={c.days_left <= 7 ? "destructive" : "warning"}>
              {c.days_left} days left
            </Badge>
          )}
        </li>
      ))}
    </ul>
  )
}
