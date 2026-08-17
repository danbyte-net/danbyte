import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { DnsProvider, Issuer, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { EmptyState } from "@/components/empty-state"
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
import { FormCheckbox, FormSelect, FormText } from "@/components/forms"

export const Route = createFileRoute("/certificate-issuers/")({
  component: IssuersPage,
})

const DNS_LABEL: Record<DnsProvider, string> = {
  "": "Manual",
  rfc2136: "RFC2136 / TSIG",
  "gss-tsig": "Windows AD (GSS-TSIG)",
}

function IssuersPage() {
  const { canDo } = useMe()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Issuer | null>(null)

  const query = useQuery({
    queryKey: ["issuers"],
    queryFn: () =>
      api<Paginated<Issuer>>("/api/monitoring/issuers/?page_size=500"),
  })
  const rows = useMemo(() => query.data?.results ?? [], [query.data])
  const canManage = canDo("issuer", "change")

  const columns = useMemo<ColumnDef<Issuer>[]>(
    () => [
      {
        id: "name",
        accessorFn: (r) => r.name,
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <button
            type="button"
            className="link font-medium"
            onClick={() => {
              setEditing(row.original)
              setFormOpen(true)
            }}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "directory_url",
        accessorFn: (r) => r.directory_url,
        header: "Directory",
        cell: ({ row }) => (
          <span className="font-mono text-[12px] text-muted-foreground">
            {row.original.directory_url}
          </span>
        ),
      },
      {
        id: "account",
        header: "Account",
        cell: ({ row }) =>
          row.original.account_registered ? (
            <Badge variant="success">Registered</Badge>
          ) : (
            <Badge variant="outline">Not registered</Badge>
          ),
      },
      {
        id: "dns",
        header: "DNS-01",
        cell: ({ row }) => (
          <span className="text-muted-foreground">
            {DNS_LABEL[row.original.dns_provider]}
          </span>
        ),
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) =>
          row.original.enabled ? (
            <Badge variant="secondary">On</Badge>
          ) : (
            <Badge variant="outline">Off</Badge>
          ),
      },
      {
        id: "created",
        header: "Created",
        cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) =>
          canManage ? (
            <div className="flex justify-end gap-1">
              <RegisterButton issuer={row.original} />
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => {
                  setEditing(row.original)
                  setFormOpen(true)
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <DeleteButton issuer={row.original} />
            </div>
          ) : null,
      },
    ],
    [canManage]
  )

  return (
    <ListPageShell
      title="Certificate authorities"
      count={rows.length}
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
    >
      {rows.length === 0 ? (
        <EmptyState title="No issuers yet.">
          Add an ACME issuer (a directory URL) to request and auto-renew
          certificates. Requires a secret store to be enabled (Settings →
          Security).
        </EmptyState>
      ) : (
        <DataTable data={rows} columns={columns} />
      )}
      <IssuerFormDialog
        key={editing?.id ?? "new"}
        issuer={editing}
        open={formOpen}
        onOpenChange={setFormOpen}
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

function DeleteButton({ issuer }: { issuer: Issuer }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const m = useMutation({
    mutationFn: () =>
      api<void>(`/api/monitoring/issuers/${issuer.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Issuer deleted")
      qc.invalidateQueries({ queryKey: ["issuers"] })
      setOpen(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        className="text-destructive hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>Delete “{issuer.name}”?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            The issuer and its stored ACME account key are removed. Certificates
            it already issued are kept.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={m.isPending}
              onClick={() => m.mutate()}
            >
              {m.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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
      toast.success(issuer ? "Issuer saved" : "Issuer created")
      qc.invalidateQueries({ queryKey: ["issuers"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
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
            hint="Turn off only for an internal CA with a self-signed cert on a trusted network."
          />
          <FormCheckbox
            label="Enabled"
            checked={enabled}
            onChange={setEnabled}
          />
          <FormText
            label="EAB key id"
            value={eabKid}
            onChange={setEabKid}
            info="External Account Binding — only if the CA requires it (some public CAs, e.g. ZeroSSL)."
          />
          {eabKid && (
            <FormText
              label="EAB HMAC key"
              value={eabHmac}
              onChange={setEabHmac}
              type="password"
              hint={
                issuer?.eab_hmac_set ? "set — blank keeps current" : undefined
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
                    ? "set — blank keeps current"
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
