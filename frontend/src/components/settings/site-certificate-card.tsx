import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Issuer, Paginated } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useDateFormat } from "@/lib/datetime"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { SettingsCard } from "@/components/settings/settings-card"
import { ConfirmButton } from "@/components/settings/plugins-section"

/** What `/api/system/site-certificate/` answers. */
export interface SiteCertificateStatus {
  host: string
  served: {
    subject: string
    cn: string
    issuer: string
    names: string[]
    not_before: string
    not_after: string
    days_left: number
    self_signed: boolean
    key: string
    fingerprint: string
    tls_version: string
  } | null
  secret_store: boolean
  source: "none" | "upload" | "self-signed" | "acme"
  auto_renew: boolean
  names: string[]
  dropped_sha256: string
  dropped_at: string | null
  dropped_reason: string
  apply: {
    unit_installed: boolean
    /** The app can write the drop folder (an installer's umask can leave it root-only). */
    writable: boolean
    drop_dir: string
    pending: boolean
    applied: {
      outcome: "applied" | "failed"
      detail: string
      sha256: string
      at: string
    } | null
  }
  acme: {
    issuer: { id: string; name: string } | null
    request_id: string
    order: {
      id: string
      status: string
      error: string
      challenge_type: string
      created_at: string
      identifiers: string[]
    } | null
  } | null
}

const KEY = ["site-certificate"]

function expiryVariant(days: number): "success" | "warning" | "destructive" {
  if (days < 7) return "destructive"
  if (days < 30) return "warning"
  return "success"
}

/**
 * The certificate Danbyte itself is served on (#126). The app never touches
 * nginx: it drops a pair in a folder it owns and the root path unit the
 * installer set up applies it, so the card shows two truths side by side -
 * what :443 presents right now, and what was last dropped and whether the
 * host took it.
 */
export function SiteCertificateCard() {
  const { me } = useMe()
  const qc = useQueryClient()
  const { formatDateTime } = useDateFormat()
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => api<SiteCertificateStatus>("/api/system/site-certificate/"),
    enabled: !!me.is_superuser,
    refetchInterval: (query) =>
      query.state.data?.apply.pending ||
      query.state.data?.acme?.order?.status === "pending" ||
      query.state.data?.acme?.order?.status === "processing"
        ? 3000
        : false,
  })
  const [dialog, setDialog] = useState<"upload" | "self-signed" | "acme" | null>(
    null
  )
  const refresh = () => qc.invalidateQueries({ queryKey: KEY })

  const autoRenew = useMutation({
    mutationFn: (on: boolean) =>
      api("/api/system/site-certificate/", {
        method: "PATCH",
        body: JSON.stringify({ auto_renew: on }),
      }),
    onSuccess: refresh,
    onError: (e) => apiErrorToast(e),
  })
  const selfSigned = useMutation({
    mutationFn: () =>
      api("/api/system/site-certificate/self-signed/", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      toast.success("Self-signed pair dropped for the host to apply")
      refresh()
    },
    onError: (e) => apiErrorToast(e),
  })
  const watch = useMutation({
    mutationFn: () =>
      api<{ id: string; host: string; created: boolean }>(
        "/api/system/site-certificate/watch/",
        { method: "POST" }
      ),
    onSuccess: (r) =>
      toast.success(
        r.created
          ? `${r.host} is now a watched endpoint`
          : `${r.host} was already watched`
      ),
    onError: (e) => apiErrorToast(e),
  })

  if (!me.is_superuser) {
    return (
      <SettingsCard title="Site certificate">
        <p className="text-sm text-muted-foreground">
          Only superusers can manage the certificate Danbyte is served on.
        </p>
      </SettingsCard>
    )
  }
  const d = q.data
  if (!d) {
    return (
      <SettingsCard title="Site certificate">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </SettingsCard>
    )
  }
  const s = d.served
  const a = d.apply
  const applied = a.applied
  const appliedMatches = applied?.sha256 === d.dropped_sha256

  return (
    <SettingsCard
      title="Site certificate"
      badge={
        s ? (
          <Badge variant={expiryVariant(s.days_left)}>
            {s.days_left < 0
              ? `expired ${-s.days_left}d ago`
              : `${s.days_left} days left`}
          </Badge>
        ) : (
          <Badge variant="destructive">nothing on :443</Badge>
        )
      }
      description="What Danbyte itself is served on. A new pair is dropped for the host to apply; nginx is never touched from here."
    >
      {s ? (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Subject</dt>
          <dd className="font-mono text-xs">
            {s.subject}
            {s.self_signed && (
              <span className="ml-2 text-muted-foreground">self-signed</span>
            )}
          </dd>
          {!s.self_signed && (
            <>
              <dt className="text-muted-foreground">Issuer</dt>
              <dd className="font-mono text-xs">{s.issuer}</dd>
            </>
          )}
          <dt className="text-muted-foreground">Names</dt>
          <dd className="font-mono text-xs">
            {s.names.map((n) => n.split(":", 2)[1]).join("  ") || "-"}
          </dd>
          <dt className="text-muted-foreground">Valid</dt>
          <dd className="font-mono text-xs">
            {formatDateTime(s.not_before)} → {formatDateTime(s.not_after)}
          </dd>
          <dt className="text-muted-foreground">Key</dt>
          <dd className="font-mono text-xs">
            {s.key} · {s.tls_version}
          </dd>
          <dt className="text-muted-foreground">SHA-256</dt>
          <dd className="truncate font-mono text-xs text-muted-foreground">
            {s.fingerprint}
          </dd>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">
          Nothing answered on port 443 for {d.host}.
        </p>
      )}

      <div className="mt-3 rounded-lg border border-border bg-card p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Source</span>
          <Badge variant="secondary">
            {
              {
                none: "not managed here",
                upload: "uploaded",
                "self-signed": "self-signed",
                acme: "ACME",
              }[d.source]
            }
          </Badge>
          {d.acme?.issuer && (
            <span className="text-muted-foreground">
              via{" "}
              <Link
                to="/certificate-issuers"
                className="link"
              >
                {d.acme.issuer.name}
              </Link>
            </span>
          )}
          <span className="ml-auto flex items-center gap-2">
            {!a.writable ? (
              <Badge variant="destructive">drop folder not writable</Badge>
            ) : !a.unit_installed ? (
              <Badge variant="warning">apply unit not installed</Badge>
            ) : a.pending ? (
              <Badge variant="warning">waiting for the host</Badge>
            ) : applied && d.dropped_sha256 ? (
              <Badge
                variant={
                  applied.outcome === "applied" && appliedMatches
                    ? "success"
                    : "destructive"
                }
              >
                {applied.outcome === "applied"
                  ? appliedMatches
                    ? "applied"
                    : "applied an older pair"
                  : "apply failed"}
              </Badge>
            ) : null}
          </span>
        </div>
        {d.dropped_at && (
          <p className="mt-1 text-xs text-muted-foreground">
            Dropped {formatDateTime(d.dropped_at)} ({d.dropped_reason})
            {applied && (
              <>
                {" "}
                · host: {applied.detail} at {formatDateTime(applied.at)}
              </>
            )}
          </p>
        )}
        {!a.writable && (
          <p className="mt-1 text-xs text-muted-foreground">
            The app cannot write <code>{a.drop_dir}</code>; give it to the
            service user: <code>chown -R danbyte:danbyte {a.drop_dir}</code>.
          </p>
        )}
        {!a.unit_installed && (
          <p className="mt-1 text-xs text-muted-foreground">
            Run <code>sudo make install-tls-unit</code> in the Danbyte
            directory once; until then a dropped pair is installed with{" "}
            <code>danbyte tls install deploy/nginx/certs/</code>.
          </p>
        )}
        {d.acme?.order && (
          <p className="mt-1 text-xs text-muted-foreground">
            Order {d.acme.order.status} ({d.acme.order.challenge_type},{" "}
            {d.acme.order.identifiers.join(", ")})
            {d.acme.order.error && (
              <span className="text-destructive"> - {d.acme.order.error}</span>
            )}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setDialog("acme")}>
          Let's Encrypt / ACME
        </Button>
        <ConfirmButton
          label="Self-signed"
          pendingLabel="Regenerating…"
          title="Regenerate the self-signed certificate?"
          body={`A fresh pair for ${(s?.names.map((n) => n.split(":", 2)[1]) ?? [d.host]).join(", ")}${
            s?.names.some((n) => n.endsWith(`:${d.host}`)) ? "" : ` and ${d.host}`
          }. Browsers that trusted the old one will ask again.`}
          onConfirm={() => selfSigned.mutate()}
          disabled={selfSigned.isPending}
          small
        />
        <Button size="sm" variant="ghost" onClick={() => setDialog("self-signed")}>
          Self-signed with other names
        </Button>
        <Button size="sm" variant="outline" onClick={() => setDialog("upload")}>
          Upload a pair
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => watch.mutate()}
          disabled={watch.isPending}
        >
          Watch {d.host} for expiry
        </Button>
        {(d.source === "self-signed" || s?.self_signed) && (
          <label className="ml-auto flex items-center gap-2 text-sm">
            <Switch
              checked={d.auto_renew}
              onCheckedChange={(on) => autoRenew.mutate(on)}
            />
            Renew self-signed automatically
            <InfoTip>
              A self-signed certificate with under thirty days left is
              regenerated for the same names on the daily expiry sweep.
            </InfoTip>
          </label>
        )}
      </div>

      {dialog === "upload" && (
        <UploadDialog onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog === "self-signed" && (
        <SelfSignedDialog
          names={
            s?.names.map((n) => n.split(":", 2)[1]) ?? [d.host]
          }
          host={d.host}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
      {dialog === "acme" && (
        <AcmeDialog
          host={d.host}
          email={me.email ?? ""}
          secretStore={d.secret_store}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </SettingsCard>
  )
}

function UploadDialog({
  onClose,
  onDone,
}: {
  onClose: () => void
  onDone: () => void
}) {
  const [cert, setCert] = useState("")
  const [key, setKey] = useState("")
  const [chain, setChain] = useState("")
  const m = useMutation({
    mutationFn: () =>
      api("/api/system/site-certificate/upload/", {
        method: "POST",
        body: JSON.stringify({ cert, key, chain }),
      }),
    onSuccess: () => {
      toast.success("Pair dropped for the host to apply")
      onDone()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Upload a certificate pair</DialogTitle>
          <DialogDescription>
            PEM text. The key is written to one root-readable file and
            nowhere else; the chain is appended for nginx.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <PemField label="Certificate" value={cert} onChange={setCert} />
          <PemField label="Private key" value={key} onChange={setKey} />
          <PemField
            label="Chain"
            hint="optional"
            value={chain}
            onChange={setChain}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={m.isPending || !cert.trim() || !key.trim()}
          >
            {m.isPending ? "Checking…" : "Install"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PemField({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
}) {
  const id = `pem-${label.toLowerCase().replace(/\s+/g, "-")}`
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Label htmlFor={id}>{label}</Label>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        <input
          type="file"
          className="ml-auto text-xs"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            void f.text().then(onChange)
          }}
        />
      </div>
      <Textarea
        id={id}
        rows={4}
        className="font-mono text-xs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="-----BEGIN …-----"
      />
    </div>
  )
}

function SelfSignedDialog({
  names,
  host,
  onClose,
  onDone,
}: {
  names: string[]
  host: string
  onClose: () => void
  onDone: () => void
}) {
  const initial = names.includes(host) ? names : [...names, host]
  const [text, setText] = useState(initial.join(", "))
  const m = useMutation({
    mutationFn: () =>
      api("/api/system/site-certificate/self-signed/", {
        method: "POST",
        body: JSON.stringify({
          names: text
            .split(/[\s,]+/)
            .map((n) => n.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => {
      toast.success("Self-signed pair dropped for the host to apply")
      onDone()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Regenerate the self-signed certificate</DialogTitle>
          <DialogDescription>
            Every name the site is reached as, comma separated. The first is
            the common name; localhost is always included.
          </DialogDescription>
        </DialogHeader>
        <Input value={text} onChange={(e) => setText(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => m.mutate()} disabled={m.isPending || !text.trim()}>
            {m.isPending ? "Generating…" : "Regenerate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AcmeDialog({
  host,
  email: initialEmail,
  secretStore,
  onClose,
  onDone,
}: {
  host: string
  email: string
  secretStore: boolean
  onClose: () => void
  onDone: () => void
}) {
  const issuers = useQuery({
    queryKey: ["issuers", "site-certificate"],
    queryFn: () => api<Paginated<Issuer>>("/api/monitoring/issuers/?page_size=100"),
  })
  const rows = (issuers.data?.results ?? []).filter((i) => i.enabled)
  const LE = "letsencrypt"
  const [issuer, setIssuer] = useState<string>(LE)
  const [email, setEmail] = useState(initialEmail)
  const [challenge, setChallenge] = useState<"http-01" | "dns-01">("http-01")
  const [text, setText] = useState(host)
  const chosen = rows.find((i) => i.id === issuer)
  const isLE = issuer === LE
  const hostIsIp = /^[0-9.]+$|:/.test(host)
  const m = useMutation({
    mutationFn: () =>
      api("/api/system/site-certificate/acme/", {
        method: "POST",
        body: JSON.stringify({
          ...(isLE ? { letsencrypt: true, email } : { issuer }),
          challenge_type: challenge,
          names: text
            .split(/[\s,]+/)
            .map((n) => n.trim())
            .filter(Boolean),
        }),
      }),
    onSuccess: () => {
      toast.success("Order opened - the pair is dropped when the issuer signs it")
      onDone()
      onClose()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Get the site's certificate from a CA</DialogTitle>
          <DialogDescription>
            Let's Encrypt out of the box, or any ACME issuer you added under
            Certificates → Issuers. Renewals run on their own from then on.
          </DialogDescription>
        </DialogHeader>
        {!secretStore && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
            Turn on a secret store first (Settings → Security → Secret store):
            the site's private key lives there between renewals.
          </p>
        )}
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label>Issuer</Label>
            <Select value={issuer} onValueChange={setIssuer}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={LE}>Let's Encrypt</SelectItem>
                {rows
                  .filter((i) => !i.directory_url.includes("acme-v02.api.letsencrypt.org"))
                  .map((i) => (
                    <SelectItem key={i.id} value={i.id}>
                      {i.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {isLE && (
            <div className="grid gap-1">
              <Label className="flex items-center gap-2">
                Account email
                <InfoTip>
                  Let's Encrypt sends expiry warnings there. Used once, when
                  the account is created.
                </InfoTip>
              </Label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          )}
          <div className="grid gap-1">
            <Label className="flex items-center gap-2">
              Challenge
              <InfoTip>
                HTTP-01: the CA fetches a token from this site over port 80,
                which Danbyte answers itself - the site must be reachable from
                the CA under its name. DNS-01: through the issuer's DNS
                publisher, for a site the CA cannot reach.
              </InfoTip>
            </Label>
            <Select
              value={challenge}
              onValueChange={(v) => setChallenge(v as "http-01" | "dns-01")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http-01">HTTP-01, answered by Danbyte</SelectItem>
                <SelectItem value="dns-01" disabled={isLE || !chosen?.dns_provider}>
                  DNS-01
                  {isLE
                    ? " - add Let's Encrypt as an issuer with a DNS publisher for this"
                    : chosen && !chosen.dns_provider
                      ? " - this issuer has no DNS publisher"
                      : ""}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label>Names</Label>
            <Input value={text} onChange={(e) => setText(e.target.value)} />
            {hostIsIp && (
              <p className="text-xs text-muted-foreground">
                A public CA signs DNS names, not addresses - put the site's
                DNS name here.
              </p>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => m.mutate()}
            disabled={
              m.isPending || !secretStore || !text.trim() || (isLE && !email.includes("@"))
            }
          >
            {m.isPending ? "Opening…" : "Order"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
