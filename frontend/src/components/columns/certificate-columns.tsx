import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  Certificate,
  CertificateOrigin,
  PublicKeyAlgorithm,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { Badge } from "@/components/ui/badge"
import { TimeCell } from "@/components/cells/time-ago"
import { dash } from "@/components/cells/dash"

// The one source of truth for "a table of certificates". The /certificates
// list builds its columns here; the detail page reuses the expiry primitives
// (`expiryTone`, `ExpiryBadge`) so a certificate's remaining life reads
// identically wherever it appears. Facet meta (useTableFilters) is attached to
// the expiry, key, and self-signed columns.

// Expiry thresholds mirror the backend alert engine defaults
// (monitoring.cert_expiry.DEFAULTS: critical 7d, warning 30d) so the colour a
// row shows agrees with when an alert would actually fire.
export const CERT_CRITICAL_DAYS = 7
export const CERT_WARNING_DAYS = 30

export type ExpiryTone = "expired" | "critical" | "warning" | "healthy"

/** Derive urgency from the server-derived `is_expired` / `days_until_expiry`,
 * never a client-side date compare — a stale row can't read as healthy. */
export function expiryTone(cert: Certificate): ExpiryTone {
  if (cert.is_expired || cert.days_until_expiry <= 0) return "expired"
  if (cert.days_until_expiry <= CERT_CRITICAL_DAYS) return "critical"
  if (cert.days_until_expiry <= CERT_WARNING_DAYS) return "warning"
  return "healthy"
}

// Reuse the app's existing severity vocabulary (see alerts.tsx / the Badge
// variants) rather than a new palette: expired = the `destructive`/down tone,
// within-critical = `warning` (amber), within-warning = the `info` caution
// tone, healthy = muted text (no pill — a cert with years left is not news).
const TONE_VARIANT: Record<
  Exclude<ExpiryTone, "healthy">,
  "destructive" | "warning" | "info"
> = {
  expired: "destructive",
  critical: "warning",
  warning: "info",
}

const TONE_LABEL: Record<ExpiryTone, string> = {
  expired: "Expired",
  critical: "Critical",
  warning: "Warning",
  healthy: "Healthy",
}

/** Short human remaining-life, e.g. "12d left", "in 3mo", "3d ago". */
function expiryText(days: number): string {
  const abs = Math.abs(days)
  const label =
    abs < 1
      ? "today"
      : abs < 45
        ? `${Math.round(abs)}d`
        : abs < 730
          ? `${Math.round(abs / 30)}mo`
          : `${Math.round(abs / 365)}y`
  if (days <= 0) return abs < 1 ? "today" : `${label} ago`
  return abs < 1 ? "today" : `${label} left`
}

/** The headline expiry treatment, reused by the list, detail hero and the
 * dashboard widget. Attention-worthy tiers get a coloured pill; a healthy cert
 * stays quiet muted text. */
export function ExpiryBadge({ cert }: { cert: Certificate }) {
  const tone = expiryTone(cert)
  const text = expiryText(cert.days_until_expiry)
  if (tone === "healthy")
    return <span className="text-xs text-muted-foreground">{text}</span>
  return (
    <Badge variant={TONE_VARIANT[tone]} className="gap-1">
      <span>{TONE_LABEL[tone]}</span>
      <span className="opacity-70">· {text}</span>
    </Badge>
  )
}

// Origin reuses the neutral Badge tones (secondary/outline) rather than a new
// colour palette — it is a provenance label, not a severity. "Uploaded" is the
// authored source of truth, "Observed" is what the wire showed, "Both" is an
// uploaded cert since seen being served (the fingerprints matched).
const ORIGIN_LABEL: Record<CertificateOrigin, string> = {
  observed: "Observed",
  uploaded: "Uploaded",
  both: "Both",
}

/** The provenance pill, reused by the list and the detail hero so a
 * certificate's origin reads identically wherever it appears. */
export function OriginBadge({ cert }: { cert: Certificate }) {
  return (
    <Badge variant="secondary" className="text-xs">
      {ORIGIN_LABEL[cert.origin]}
    </Badge>
  )
}

const ALG_LABEL: Record<PublicKeyAlgorithm, string> = {
  rsa: "RSA",
  ec: "ECDSA",
  ed25519: "Ed25519",
  ed448: "Ed448",
  dsa: "DSA",
  unknown: "Unknown",
}

/** "RSA 2048", "ECDSA 256" — algorithm plus key size. */
export function fmtKey(cert: Certificate): string {
  const alg = ALG_LABEL[cert.public_key_algorithm]
  return cert.public_key_bits != null ? `${alg} ${cert.public_key_bits}` : alg
}

export type CertificateColumnId =
  | "subject"
  | "issuer"
  | "expiry"
  | "origin"
  | "key"
  | "endpoints"
  | "assignments"
  | "self_signed"
  | "kind"
  | "last_seen"

const CANONICAL_ORDER: CertificateColumnId[] = [
  "subject",
  "issuer",
  "expiry",
  "origin",
  "key",
  "endpoints",
  "assignments",
  "self_signed",
  "kind",
  "last_seen",
]

export interface CertificateColumnOpts {
  /** Drop columns. */
  omit?: CertificateColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CertificateColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
}

export function buildCertificateColumns<T extends Certificate = Certificate>(
  opts: CertificateColumnOpts = {}
): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const keep = (id: CertificateColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<CertificateColumnId, () => ColumnDef<T, unknown>> = {
    subject: () => ({
      id: "subject",
      accessorFn: (c) => c.subject_cn || c.subject,
      header: ({ column }) => <SortHeader column={column} label="Subject" />,
      cell: ({ row }) => (
        <Link
          to="/certificates/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.subject_cn ||
            row.original.subject ||
            `${row.original.fingerprint_sha256.slice(0, 16)}…`}
        </Link>
      ),
    }),
    issuer: () => ({
      id: "issuer",
      accessorFn: (c) => c.issuer_cn || c.issuer,
      header: "Issuer",
      cell: ({ row }) => (
        <span className="text-xs">
          {row.original.issuer_cn || row.original.issuer || "—"}
        </span>
      ),
    }),
    expiry: () => ({
      id: "expiry",
      // Sort by urgency, not the label: most urgent (smallest / negative
      // days-remaining) first. The list also arrives pre-ordered by not_after
      // from the API, so the default view already leads with what expires next.
      accessorFn: (c) => c.days_until_expiry,
      sortingFn: "basic",
      header: ({ column }) => <SortHeader column={column} label="Expiry" />,
      cell: ({ row }) => <ExpiryBadge cert={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Expiry",
          get: (r: T) => expiryTone(r),
          formatValue: (v) => ({
            label:
              v === "expired"
                ? "Expired"
                : v === "critical"
                  ? `Critical (≤${CERT_CRITICAL_DAYS}d)`
                  : v === "warning"
                    ? `Warning (≤${CERT_WARNING_DAYS}d)`
                    : "Healthy",
          }),
        },
      },
    }),
    origin: () => ({
      id: "origin",
      accessorFn: (c) => c.origin,
      header: "Origin",
      cell: ({ row }) => <OriginBadge cert={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Origin",
          get: (r: T) => r.origin,
          formatValue: (v) => ({ label: ORIGIN_LABEL[v as CertificateOrigin] }),
        },
      },
    }),
    key: () => ({
      id: "key",
      accessorFn: (c) => c.public_key_algorithm,
      header: "Key",
      cell: ({ row }) => (
        <span className="text-xs">{fmtKey(row.original)}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Key algorithm",
          get: (r: T) => r.public_key_algorithm,
          formatValue: (_v, sample) => ({
            label: ALG_LABEL[sample.public_key_algorithm],
          }),
        },
      },
    }),
    endpoints: () => ({
      id: "endpoints",
      accessorFn: (c) => c.binding_count,
      header: ({ column }) => <SortHeader column={column} label="Endpoints" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.binding_count}</span>
      ),
    }),
    assignments: () => ({
      id: "assignments",
      accessorFn: (c) => c.assignment_count,
      header: ({ column }) => <SortHeader column={column} label="Assigned" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.assignment_count}</span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Assigned",
          get: (r: T) => (r.assignment_count > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Assigned to an object" : "Unassigned",
          }),
        },
      },
    }),
    self_signed: () => ({
      id: "self_signed",
      accessorFn: (c) => (c.self_signed ? "self" : "ca"),
      header: "Self-signed",
      cell: ({ row }) =>
        row.original.self_signed ? (
          <Badge variant="outline" className="text-xs">
            Self-signed
          </Badge>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Trust",
          get: (r: T) => (r.self_signed ? "self" : "ca"),
          formatValue: (v) => ({
            label: v === "self" ? "Self-signed" : "CA-issued",
          }),
        },
      },
    }),
    kind: () => ({
      id: "kind",
      accessorFn: (c) => (c.is_ca ? "ca" : "leaf"),
      header: "Kind",
      cell: ({ row }) =>
        row.original.is_ca ? (
          <Badge variant="secondary" className="text-xs">
            CA
          </Badge>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (r: T) => (r.is_ca ? "ca" : "leaf"),
          formatValue: (v) => ({
            label: v === "ca" ? "Certificate authority" : "End-entity (leaf)",
          }),
        },
      },
    }),
    last_seen: () => ({
      id: "last_seen",
      accessorFn: (c) => c.last_seen ?? "",
      header: ({ column }) => <SortHeader column={column} label="Last seen" />,
      cell: ({ row }) =>
        row.original.last_seen ? (
          <TimeCell iso={row.original.last_seen} />
        ) : (
          dash
        ),
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  return cols
}
